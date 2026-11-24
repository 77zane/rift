use crate::config::{save_config, RiftConfig};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(windows)]
use std::process::Stdio;

const MARKER_START: &str = "# >>> rift auto-mirror hook >>>";
const MARKER_END: &str = "# <<< rift auto-mirror hook <<<";

pub struct SetupOptions {
    pub config: RiftConfig,
    pub no_hook: bool,
    pub with_hook: bool,
    pub no_autostart: bool,
}

fn permanent_exe_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("无法获取用户主目录")?;
    #[cfg(windows)]
    {
        Ok(home.join(".rift").join("bin").join("rift.exe"))
    }
    #[cfg(not(windows))]
    {
        let is_root = std::env::var("USER").map(|u| u == "root").unwrap_or(false);
        if is_root {
            Ok(PathBuf::from("/usr/local/bin/rift"))
        } else {
            Ok(home.join(".local").join("bin").join("rift"))
        }
    }
}

fn install_binary() -> Result<PathBuf> {
    let current = std::env::current_exe().context("无法获取当前 rift 可执行文件路径")?;
    let target = permanent_exe_path()?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }

    let same = current
        .canonicalize()
        .ok()
        .zip(target.canonicalize().ok())
        .map(|(a, b)| a == b)
        .unwrap_or(false);

    if !same {
        // On Windows, running executables cannot be overwritten in-place, but can be renamed aside.
        // Use a unique `.old.<ts>` fallback if a previous `rift.exe.old` is still locked by an open session.
        #[cfg(windows)]
        let mut renamed_backup: Option<PathBuf> = None;
        #[cfg(windows)]
        {
            stop_windows_daemon();
            if let Some(parent) = target.parent() {
                if let Ok(entries) = fs::read_dir(parent) {
                    for entry in entries.flatten() {
                        let name = entry.file_name();
                        if name.to_string_lossy().starts_with("rift.exe.old") {
                            let _ = fs::remove_file(entry.path());
                        }
                    }
                }
            }
            if target.exists() {
                let primary_backup = target.with_extension("exe.old");
                let backup = if !primary_backup.exists() {
                    primary_backup
                } else {
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    target.with_extension(format!("exe.old.{ts}"))
                };
                if fs::rename(&target, &backup).is_ok() {
                    renamed_backup = Some(backup);
                }
            }
        }
        if let Err(e) = fs::copy(&current, &target) {
            #[cfg(windows)]
            {
                if let Some(backup) = renamed_backup {
                    if !target.exists() && backup.exists() {
                        let _ = fs::rename(&backup, &target);
                    }
                }
            }
            eprintln!(
                "[rift setup] 提示：更新 {} 失败（可能正被运行中进程占用: {e}），将继续使用已有路径。",
                target.display()
            );
            if !target.exists() {
                return Ok(current);
            }
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&target, fs::Permissions::from_mode(0o755));
    }

    #[cfg(windows)]
    {
        if let Some(bin_dir) = target.parent() {
            let _ = ensure_windows_user_path(bin_dir);
        }
    }

    Ok(target)
}

#[cfg(windows)]
fn ensure_windows_user_path(bin_dir: &Path) -> Result<()> {
    let dir_str = bin_dir.to_string_lossy().to_string();
    let ps = format!(
        "$p = [Environment]::GetEnvironmentVariable('Path', 'User'); \
         if (-not $p) {{ $p = '' }}; \
         $parts = $p -split ';' | Where-Object {{ $_ -ne '' }}; \
         if ($parts -notcontains '{dir_str}') {{ \
           [Environment]::SetEnvironmentVariable('Path', (($parts + '{dir_str}') -join ';'), 'User') \
         }}"
    );
    let _ = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", &ps])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    Ok(())
}

fn strip_marked_block(content: &str) -> String {
    if let (Some(start), Some(end)) = (content.find(MARKER_START), content.find(MARKER_END)) {
        let after_end = end + MARKER_END.len();
        let before = &content[..start];
        let after = content[after_end..].trim_start_matches(['\r', '\n']);
        format!("{before}{after}")
    } else {
        content.to_string()
    }
}

fn write_marked_block(path: &Path, block: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let raw = fs::read_to_string(path).unwrap_or_default();
    // Strip UTF-8 BOM (\u{feff}) anywhere in file so prepending our hook never leaves an invisible BOM on a later line.
    let existing = raw.replace('\u{feff}', "");
    let cleaned = strip_marked_block(&existing);
    let updated = if cleaned.trim().is_empty() {
        block.to_string()
    } else {
        format!("{block}\n{cleaned}")
    };
    fs::write(path, updated)?;
    Ok(())
}

fn remove_marked_block(path: &Path) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let existing = fs::read_to_string(path)?;
    if !existing.contains(MARKER_START) {
        return Ok(false);
    }
    let cleaned = strip_marked_block(&existing);
    fs::write(path, cleaned)?;
    Ok(true)
}

fn install_shell_hooks(exe: &Path) -> Result<Vec<String>> {
    let home = dirs::home_dir().context("无法获取用户主目录")?;
    let exe_str = exe.to_string_lossy();
    let mut installed = Vec::new();

    #[cfg(windows)]
    {
        // 1. PowerShell 7 ($PROFILE)
        let ps7 = home
            .join("Documents")
            .join("PowerShell")
            .join("Microsoft.PowerShell_profile.ps1");
        let ps7_block = format!(
            "{MARKER_START}\r\nif (-not $env:RIFT_SESSION_ID -and -not $env:RIFT_DISABLE -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {{\r\n    & \"{exe_str}\" -- pwsh.exe\r\n    exit $LASTEXITCODE\r\n}}\r\n{MARKER_END}\r\n"
        );
        write_marked_block(&ps7, &ps7_block)?;
        installed.push(format!("PowerShell 7 ({})", ps7.display()));

        // 2. Windows PowerShell 5.1 ($PROFILE)
        let ps5 = home
            .join("Documents")
            .join("WindowsPowerShell")
            .join("Microsoft.PowerShell_profile.ps1");
        let ps5_block = format!(
            "{MARKER_START}\r\nif (-not $env:RIFT_SESSION_ID -and -not $env:RIFT_DISABLE -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {{\r\n    & \"{exe_str}\" -- powershell.exe\r\n    exit $LASTEXITCODE\r\n}}\r\n{MARKER_END}\r\n"
        );
        write_marked_block(&ps5, &ps5_block)?;
        installed.push(format!("PowerShell 5.1 ({})", ps5.display()));

        // 3. CMD AutoRun (strictly interactive only: skip /c or /k batch invocations!)
        let cmd_script = home.join(".rift").join("cmd-autorun.cmd");
        if let Some(parent) = cmd_script.parent() {
            fs::create_dir_all(parent)?;
        }
        let cmd_body = format!(
            "@echo off\r\nif defined RIFT_SESSION_ID goto :eof\r\nif defined RIFT_DISABLE goto :eof\r\necho %CMDCMDLINE% | findstr /I \" /c /k\" >nul && goto :eof\r\n\"{exe_str}\" -- cmd.exe\r\nexit /b %ERRORLEVEL%\r\n"
        );
        fs::write(&cmd_script, cmd_body)?;
        let _ = Command::new("reg.exe")
            .args([
                "add",
                r"HKCU\Software\Microsoft\Command Processor",
                "/v",
                "AutoRun",
                "/t",
                "REG_SZ",
                "/d",
                &cmd_script.to_string_lossy(),
                "/f",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        installed.push(format!("CMD AutoRun ({})", cmd_script.display()));

        // 4. Git Bash (~/.bashrc if already present)
        let bashrc = home.join(".bashrc");
        if bashrc.exists() {
            let exe_posix = exe_str.replace('\\', "/");
            let bash_block = format!(
                "{MARKER_START}\nif [ -t 0 ] && [ -z \"$RIFT_SESSION_ID\" ] && [ -z \"$RIFT_DISABLE\" ]; then\n  exec \"{exe_posix}\" -- \"$SHELL\"\nfi\n{MARKER_END}\n"
            );
            write_marked_block(&bashrc, &bash_block)?;
            installed.push(format!("Git Bash ({})", bashrc.display()));
        }
    }

    #[cfg(not(windows))]
    {
        for rc in [".bashrc", ".zshrc"] {
            let p = home.join(rc);
            if p.exists() || rc == ".bashrc" {
                let block = format!(
                    "{MARKER_START}\nif [ -t 0 ] && [ -z \"$RIFT_SESSION_ID\" ] && [ -z \"$RIFT_DISABLE\" ]; then\n  exec \"{exe_str}\" -- \"$SHELL\"\nfi\n{MARKER_END}\n"
                );
                write_marked_block(&p, &block)?;
                installed.push(format!("{rc} ({})", p.display()));
            }
        }
    }

    Ok(installed)
}

fn uninstall_shell_hooks() -> Result<Vec<String>> {
    let home = dirs::home_dir().context("无法获取用户主目录")?;
    let mut removed = Vec::new();

    #[cfg(windows)]
    {
        for (label, path) in [
            (
                "PowerShell 7",
                home.join("Documents")
                    .join("PowerShell")
                    .join("Microsoft.PowerShell_profile.ps1"),
            ),
            (
                "PowerShell 5.1",
                home.join("Documents")
                    .join("WindowsPowerShell")
                    .join("Microsoft.PowerShell_profile.ps1"),
            ),
            ("Git Bash", home.join(".bashrc")),
        ] {
            if remove_marked_block(&path).unwrap_or(false) {
                removed.push(label.to_string());
            }
        }

        // Remove CMD AutoRun only if it points to our cmd-autorun.cmd
        let cmd_script = home.join(".rift").join("cmd-autorun.cmd");
        let out = Command::new("reg.exe")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Command Processor",
                "/v",
                "AutoRun",
            ])
            .output();
        if let Ok(o) = out {
            let s = String::from_utf8_lossy(&o.stdout);
            if s.contains("cmd-autorun.cmd") {
                let _ = Command::new("reg.exe")
                    .args([
                        "delete",
                        r"HKCU\Software\Microsoft\Command Processor",
                        "/v",
                        "AutoRun",
                        "/f",
                    ])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                removed.push("CMD AutoRun".to_string());
            }
        }
        let _ = fs::remove_file(cmd_script);
    }

    #[cfg(not(windows))]
    {
        for rc in [".bashrc", ".zshrc"] {
            if remove_marked_block(&home.join(rc)).unwrap_or(false) {
                removed.push(rc.to_string());
            }
        }
    }

    Ok(removed)
}

fn merge_claude_hooks(root: &mut Value, exe_str: &str) {
    if let Some(obj) = root.as_object_mut() {
        let hooks_val = obj.entry("hooks").or_insert_with(|| json!({}));
        if let Some(hooks_obj) = hooks_val.as_object_mut() {
            for (hook_name, matcher, ev) in [
                ("UserPromptSubmit", "*", "running"),
                ("PreToolUse", "*", "tool"),
                ("Notification", "permission_prompt|elicitation_dialog", "waiting"),
                ("Stop", "*", "idle"),
            ] {
                let arr = hooks_obj
                    .entry(hook_name)
                    .or_insert_with(|| json!([]))
                    .as_array_mut();
                if let Some(list) = arr {
                    // Remove any prior rift agent-hook entry before inserting fresh one
                    list.retain(|item| !item.to_string().contains("agent-hook --agent claude"));
                    list.push(json!({
                        "matcher": matcher,
                        "hooks": [
                            {
                                "type": "command",
                                "command": format!("\"{exe_str}\" agent-hook --agent claude --event {ev}")
                            }
                        ]
                    }));
                }
            }
        }
    }
}

fn install_agent_hooks(exe: &Path) -> Result<Vec<String>> {
    let home = dirs::home_dir().context("无法获取用户主目录")?;
    let exe_str = exe.to_string_lossy();
    let mut installed = Vec::new();

    // 1. Antigravity CLI (agy): ~/.gemini/config/plugins/rift-agent-hooks/
    let gemini_cfg = home.join(".gemini").join("config");
    if gemini_cfg.exists() {
        let plugin_dir = gemini_cfg.join("plugins").join("rift-agent-hooks");
        fs::create_dir_all(&plugin_dir)?;
        let plugin_json = json!({
            "name": "rift-agent-hooks",
            "description": "Rift lightweight active agent state reporter (read-only)"
        });
        fs::write(
            plugin_dir.join("plugin.json"),
            serde_json::to_string_pretty(&plugin_json)?,
        )?;

        let make_cmd = |event: &str, decision: Option<&str>| match decision {
            Some(d) => format!("\"{exe_str}\" agent-hook --agent agy --event {event} --decision {d}"),
            None => format!("\"{exe_str}\" agent-hook --agent agy --event {event} --print-json"),
        };

        let hooks_json = json!({
            "rift-agent-hooks": {
                "PreInvocation": [
                    { "type": "command", "command": make_cmd("running", None), "timeout": 3 }
                ],
                "PostToolUse": [
                    {
                        "matcher": "*",
                        "hooks": [
                            { "type": "command", "command": make_cmd("tool", None), "timeout": 3 }
                        ]
                    }
                ],
                "Stop": [
                    { "type": "command", "command": make_cmd("idle", None), "timeout": 3 }
                ]
            }
        });
        fs::write(
            plugin_dir.join("hooks.json"),
            serde_json::to_string_pretty(&hooks_json)?,
        )?;
        installed.push(format!("Antigravity (agy) ({})", plugin_dir.display()));
    }

    // 2. Claude Code: ~/.claude/settings.json
    let claude_dir = home.join(".claude");
    if claude_dir.exists() {
        let settings_path = claude_dir.join("settings.json");
        let mut root: Value = fs::read_to_string(&settings_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| json!({}));

        merge_claude_hooks(&mut root, &exe_str);
        fs::write(&settings_path, serde_json::to_string_pretty(&root)?)?;
        installed.push(format!("Claude Code ({})", settings_path.display()));
    }

    Ok(installed)
}

fn uninstall_agent_hooks() -> Result<Vec<String>> {
    let home = dirs::home_dir().context("无法获取用户主目录")?;
    let mut removed = Vec::new();

    let agy_plugin = home
        .join(".gemini")
        .join("config")
        .join("plugins")
        .join("rift-agent-hooks");
    if agy_plugin.exists() {
        fs::remove_dir_all(&agy_plugin)?;
        removed.push("Antigravity (agy)".to_string());
    }

    let claude_settings = home.join(".claude").join("settings.json");
    if claude_settings.exists() {
        if let Ok(text) = fs::read_to_string(&claude_settings) {
            if text.contains("agent-hook --agent claude") {
                if let Ok(mut root) = serde_json::from_str::<Value>(&text) {
                    if let Some(hooks_obj) = root.get_mut("hooks").and_then(|v| v.as_object_mut()) {
                        for (_k, v) in hooks_obj.iter_mut() {
                            if let Some(list) = v.as_array_mut() {
                                list.retain(|item| {
                                    !item.to_string().contains("agent-hook --agent claude")
                                });
                            }
                        }
                    }
                    let _ = fs::write(&claude_settings, serde_json::to_string_pretty(&root)?);
                    removed.push("Claude Code".to_string());
                }
            }
        }
    }

    Ok(removed)
}

#[cfg(windows)]
fn stop_windows_daemon() {
    let _ = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'rift.exe' -and $_.CommandLine -match 'daemon' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn install_autostart_and_launch(exe: &Path) -> Result<String> {
    #[cfg(windows)]
    {
        let home = dirs::home_dir().context("无法获取用户主目录")?;
        let vbs_path = home.join(".rift").join("start-daemon.vbs");
        if let Some(parent) = vbs_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let expected_exe = home.join(".rift").join("bin").join("rift.exe");
        let vbs_body = if exe == expected_exe {
            // Pure-ASCII VBS using %USERPROFILE% so Windows Script Host (ANSI/GBK) works
            // reliably even on non-ASCII/Chinese Windows usernames.
            "Set sh = CreateObject(\"WScript.Shell\")\r\nhomeDir = sh.ExpandEnvironmentStrings(\"%USERPROFILE%\")\r\nsh.CurrentDirectory = homeDir\r\nsh.Run \"\"\"\" & homeDir & \"\\.rift\\bin\\rift.exe\"\" daemon\", 0, False\r\n".to_string()
        } else {
            let exe_escaped = exe.to_string_lossy().replace('"', "\"\"");
            let home_escaped = home.to_string_lossy().replace('"', "\"\"");
            format!(
                "Set sh = CreateObject(\"WScript.Shell\")\r\nsh.CurrentDirectory = \"{home_escaped}\"\r\nsh.Run \"\"\"{exe_escaped}\"\" daemon\", 0, False\r\n"
            )
        };
        fs::write(&vbs_path, vbs_body)?;

        let cmd_val = format!(
            "C:\\Windows\\System32\\wscript.exe //B //Nologo \"{}\"",
            vbs_path.to_string_lossy()
        );
        let _ = Command::new("reg.exe")
            .args([
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "RiftDaemon",
                "/t",
                "REG_SZ",
                "/d",
                &cmd_val,
                "/f",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        // Replace any existing daemon instance so we never leave duplicates or stale binaries
        stop_windows_daemon();

        // Launch daemon immediately in background (no console window, detached from parent job)
        let mut daemon_cmd = Command::new(exe);
        daemon_cmd.arg("daemon").current_dir(&home);
        let _ = crate::daemon::spawn_detached_command(&mut daemon_cmd);

        Ok("Windows 用户级静默开机自启 (wscript + start-daemon.vbs，无黑框) + 已立即后台启动".to_string())
    }

    #[cfg(not(windows))]
    {
        let exe_str = exe.to_string_lossy();
        let home = dirs::home_dir().context("无法获取用户主目录")?;
        let home_str = home.to_string_lossy();
        let unit = format!(
            "[Unit]\nDescription=Rift Host Daemon\nAfter=network-online.target\n\n[Service]\nType=simple\nEnvironment=HOME={home_str}\nWorkingDirectory={home_str}\nExecStart={exe_str} daemon\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n"
        );
        let is_root = std::env::var("USER").map(|u| u == "root").unwrap_or(false);
        if is_root {
            let p = PathBuf::from("/etc/systemd/system/rift-daemon.service");
            fs::write(&p, unit)?;
            let _ = Command::new("systemctl").args(["daemon-reload"]).status();
            let _ = Command::new("systemctl")
                .args(["enable", "--now", "rift-daemon"])
                .status();
            Ok("systemd 系统服务 (rift-daemon.service) 已启用并启动".to_string())
        } else {
            let dir = home.join(".config").join("systemd").join("user");
            fs::create_dir_all(&dir)?;
            let p = dir.join("rift-daemon.service");
            fs::write(&p, unit)?;
            let _ = Command::new("systemctl")
                .args(["--user", "daemon-reload"])
                .status();
            let _ = Command::new("systemctl")
                .args(["--user", "enable", "--now", "rift-daemon"])
                .status();
            Ok("systemd 用户服务 (rift-daemon.service) 已启用并启动".to_string())
        }
    }
}

fn uninstall_autostart() -> Result<bool> {
    #[cfg(windows)]
    {
        let _ = Command::new("reg.exe")
            .args([
                "delete",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "RiftDaemon",
                "/f",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if let Some(home) = dirs::home_dir() {
            let _ = fs::remove_file(home.join(".rift").join("start-daemon.vbs"));
        }
        stop_windows_daemon();
        Ok(true)
    }

    #[cfg(not(windows))]
    {
        let is_root = std::env::var("USER").map(|u| u == "root").unwrap_or(false);
        if is_root {
            let _ = Command::new("systemctl")
                .args(["disable", "--now", "rift-daemon"])
                .status();
            let _ = fs::remove_file("/etc/systemd/system/rift-daemon.service");
            let _ = Command::new("systemctl").args(["daemon-reload"]).status();
        } else if let Some(home) = dirs::home_dir() {
            let _ = Command::new("systemctl")
                .args(["--user", "disable", "--now", "rift-daemon"])
                .status();
            let _ = fs::remove_file(
                home.join(".config")
                    .join("systemd")
                    .join("user")
                    .join("rift-daemon.service"),
            );
            let _ = Command::new("systemctl")
                .args(["--user", "daemon-reload"])
                .status();
        }
        Ok(true)
    }
}

pub fn run_setup(opts: SetupOptions) -> Result<()> {
    let exe = install_binary()?;
    let cfg_path = save_config(&opts.config)?;

    println!("┌─ RIFT SETUP COMPLETE ─┐");
    println!("  [1] 可执行文件 : {}", exe.display());
    println!("  [2] 配置文件   : {}", cfg_path.display());
    println!(
        "      中转地址   : {}  (主机名: {})",
        opts.config.relay, opts.config.host
    );

    let should_install_shell_hooks = if cfg!(windows) {
        !opts.no_hook
    } else {
        opts.with_hook && !opts.no_hook
    };

    if should_install_shell_hooks {
        let hooks = install_shell_hooks(&exe)?;
        println!("  [3] 终端自动捆绑:");
        for h in hooks {
            println!("      ✓ {h}");
        }
    } else {
        println!("  [3] 终端自动捆绑: 已跳过");
    }

    if !opts.no_hook {
        let agents = install_agent_hooks(&exe)?;
        if agents.is_empty() {
            println!("  [4] AI Agent 状态钩子: 未检测到已安装的 agy/claude，已跳过");
        } else {
            println!("  [4] AI Agent 主动状态汇报钩子:");
            for a in agents {
                println!("      ✓ {a}");
            }
        }
    }

    if !opts.no_autostart {
        let status = install_autostart_and_launch(&exe)?;
        println!("  [5] 开机自启守护: {status}");
    } else {
        println!("  [5] 开机自启守护: 已跳过");
    }

    println!("\n提示：随时可运行 `rift uninstall` 一键干净还原所有配置与钩子。");
    Ok(())
}

pub fn run_uninstall(purge: bool) -> Result<()> {
    let _ = uninstall_autostart();
    let shell_removed = uninstall_shell_hooks()?;
    let agent_removed = uninstall_agent_hooks()?;

    println!("┌─ RIFT UNINSTALLED ─┐");
    println!("  ✓ 已停止并移除开机自启守护进程");
    if !shell_removed.is_empty() {
        println!("  ✓ 已移除终端钩子: {}", shell_removed.join(", "));
    }
    if !agent_removed.is_empty() {
        println!("  ✓ 已移除 AI Agent 钩子: {}", agent_removed.join(", "));
    }
    if purge {
        if let Some(home) = dirs::home_dir() {
            let _ = fs::remove_dir_all(home.join(".rift"));
            println!("  ✓ 已清理 ~/.rift 目录");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bugtdd_3_claude_notification_hook_never_uses_wildcard_matcher() {
        let mut settings = json!({
            "hooks": {
                "Notification": [
                    { "matcher": "*", "hooks": [{ "type": "command", "command": "echo user-custom" }] },
                    { "matcher": "*", "hooks": [{ "type": "command", "command": "\"old-rift\" agent-hook --agent claude --event waiting" }] }
                ]
            }
        });

        merge_claude_hooks(&mut settings, "/usr/local/bin/rift");

        let notif = settings["hooks"]["Notification"].as_array().expect("Notification array");
        // User's custom hook preserved, stale rift hook replaced by fresh one
        assert_eq!(notif.len(), 2);
        let rift_entry = notif
            .iter()
            .find(|item| item.to_string().contains("agent-hook --agent claude"))
            .expect("rift notification hook");
        assert_eq!(
            rift_entry["matcher"].as_str(),
            Some("permission_prompt|elicitation_dialog")
        );

        // Idempotent when invoked a second time
        merge_claude_hooks(&mut settings, "/usr/local/bin/rift");
        assert_eq!(settings["hooks"]["Notification"].as_array().unwrap().len(), 2);
    }
}
