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

#[cfg_attr(not(windows), allow(dead_code))]
fn remove_path_entry(path_env: &str, target_dir: &str) -> Option<String> {
    let normalize = |s: &str| {
        s.trim()
            .trim_matches('"')
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    };
    let needle = normalize(target_dir);
    if needle.is_empty() {
        return None;
    }
    let mut removed = false;
    let kept: Vec<&str> = path_env
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .filter(|part| {
            if normalize(part) == needle {
                removed = true;
                false
            } else {
                true
            }
        })
        .collect();
    if removed {
        Some(kept.join(";"))
    } else {
        None
    }
}

#[cfg(windows)]
fn remove_windows_user_path(bin_dir: &Path) -> Result<bool> {
    let out = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); \
             $p = [Environment]::GetEnvironmentVariable('Path', 'User'); \
             if ($p) { [Console]::Out.Write($p) }",
        ])
        .output()?;
    if !out.status.success() {
        return Ok(false);
    }
    let current_path = String::from_utf8_lossy(&out.stdout);
    let Some(updated) = remove_path_entry(&current_path, &bin_dir.to_string_lossy()) else {
        return Ok(false);
    };
    let status = Command::new("powershell.exe")
        .env("RIFT_NEW_USER_PATH", &updated)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Environment]::SetEnvironmentVariable('Path', $env:RIFT_NEW_USER_PATH, 'User')",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    Ok(status.success())
}

fn strip_marked_block(content: &str) -> String {
    if let (Some(start), Some(end)) = (content.find(MARKER_START), content.find(MARKER_END)) {
        if start <= end {
            let after_end = end + MARKER_END.len();
            let before = &content[..start];
            let after = content[after_end..].trim_start_matches(['\r', '\n']);
            return format!("{before}{after}");
        }
    }
    content.to_string()
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
    if cleaned.trim().is_empty() {
        let _ = fs::remove_file(path);
    } else {
        fs::write(path, cleaned)?;
    }
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

fn prune_claude_hooks(root: &mut Value) -> bool {
    let mut changed = false;
    let mut remove_hooks_key = false;
    if let Some(hooks_obj) = root.get_mut("hooks").and_then(|v| v.as_object_mut()) {
        let mut empty_keys = Vec::new();
        for (k, v) in hooks_obj.iter_mut() {
            if let Some(list) = v.as_array_mut() {
                let before = list.len();
                list.retain(|item| !item.to_string().contains("agent-hook --agent claude"));
                if list.len() != before {
                    changed = true;
                    if list.is_empty() {
                        empty_keys.push(k.clone());
                    }
                }
            }
        }
        for k in empty_keys {
            hooks_obj.remove(&k);
        }
        if changed && hooks_obj.is_empty() {
            remove_hooks_key = true;
        }
    }
    if remove_hooks_key {
        if let Some(obj) = root.as_object_mut() {
            obj.remove("hooks");
        }
    }
    changed
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
                    if prune_claude_hooks(&mut root) {
                        let _ = fs::write(&claude_settings, serde_json::to_string_pretty(&root)?);
                        removed.push("Claude Code".to_string());
                    }
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

#[derive(Debug, PartialEq, Eq)]
enum PurgeOutcome {
    NothingToRemove,
    Removed,
    RemovedWithTempCleanup(PathBuf),
    ScheduledDelayedCleanup(PathBuf),
}

fn clear_or_stage_dir(dir: &Path, staged_dir: &Path, counter: &mut usize) -> bool {
    let mut staged_any = false;
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            if fs::remove_dir_all(&path).is_err() {
                if clear_or_stage_dir(&path, staged_dir, counter) {
                    staged_any = true;
                }
                let _ = fs::remove_dir(&path);
            }
        } else if fs::remove_file(&path).is_err() && fs::create_dir_all(staged_dir).is_ok() {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".to_string());
            let dst = staged_dir.join(format!("{}-{name}", *counter));
            *counter += 1;
            if fs::rename(&path, &dst).is_ok() {
                staged_any = true;
            }
        }
    }
    staged_any
}

fn purge_install_artifacts(
    rift_dir: &Path,
    external_exe: Option<&Path>,
    temp_base: &Path,
) -> PurgeOutcome {
    let has_dir = rift_dir.exists();
    let ext_target = external_exe.filter(|p| !p.starts_with(rift_dir) && p.exists());
    if !has_dir && ext_target.is_none() {
        return PurgeOutcome::NothingToRemove;
    }

    let mut ext_locked = false;
    if let Some(bin) = ext_target {
        if fs::remove_file(bin).is_err() {
            ext_locked = true;
        }
    }

    if !has_dir {
        return if ext_locked {
            PurgeOutcome::ScheduledDelayedCleanup(ext_target.unwrap().to_path_buf())
        } else {
            PurgeOutcome::Removed
        };
    }

    if fs::remove_dir_all(rift_dir).is_ok() && !ext_locked {
        return PurgeOutcome::Removed;
    }

    // Windows cannot delete a running executable in place, but NTFS allows renaming it aside
    // into %TEMP% on the same volume so ~/.rift itself disappears immediately.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let staged_dir = temp_base.join(format!("rift-uninstall-{}-{ts}", std::process::id()));
    let mut counter = 0usize;
    let staged_any = clear_or_stage_dir(rift_dir, &staged_dir, &mut counter);
    let _ = fs::remove_dir_all(rift_dir);

    if !rift_dir.exists() && !ext_locked {
        if staged_any {
            PurgeOutcome::RemovedWithTempCleanup(staged_dir)
        } else {
            PurgeOutcome::Removed
        }
    } else {
        PurgeOutcome::ScheduledDelayedCleanup(rift_dir.to_path_buf())
    }
}

#[cfg(windows)]
fn schedule_windows_post_exit_cleanup(target: &Path) {
    let mut cmd = Command::new("powershell.exe");
    cmd.env("RIFT_SELF_PID", std::process::id().to_string())
        .env("RIFT_PURGE_TARGET", target)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            "Wait-Process -Id ([int]$env:RIFT_SELF_PID) -Timeout 5 -ErrorAction SilentlyContinue; \
             for ($i = 0; $i -lt 10; $i++) { \
               if (-not (Test-Path -LiteralPath $env:RIFT_PURGE_TARGET)) { break }; \
               Remove-Item -LiteralPath $env:RIFT_PURGE_TARGET -Recurse -Force -ErrorAction SilentlyContinue; \
               Start-Sleep -Milliseconds 300 \
             }",
        ]);
    let _ = crate::daemon::spawn_detached_command(&mut cmd);
}

#[cfg(windows)]
fn has_other_rift_processes() -> bool {
    if std::env::var("RIFT_SESSION_ID")
        .map(|s| !s.is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    let self_pid = std::process::id();
    let out = Command::new("powershell.exe")
        .env("RIFT_SELF_PID", self_pid.to_string())
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$self = [int]$env:RIFT_SELF_PID; \
             @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'rift.exe' -and $_.ProcessId -ne $self }).Count",
        ])
        .output();
    out.ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<usize>().ok())
        .map(|n| n > 0)
        .unwrap_or(false)
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
            let rift_dir = home.join(".rift");
            #[cfg(windows)]
            {
                let bin_dir = rift_dir.join("bin");
                if remove_windows_user_path(&bin_dir).unwrap_or(false) {
                    println!("  ✓ 已从用户 PATH 移除 {}", bin_dir.display());
                }
            }

            let ext_exe = permanent_exe_path().ok();
            let outcome =
                purge_install_artifacts(&rift_dir, ext_exe.as_deref(), &std::env::temp_dir());
            match outcome {
                PurgeOutcome::NothingToRemove => {
                    println!("  ✓ 未发现残留的 ~/.rift 或已安装程序");
                }
                PurgeOutcome::Removed => {
                    println!("  ✓ 已彻底清理 ~/.rift 目录与已安装可执行文件");
                }
                PurgeOutcome::RemovedWithTempCleanup(staged_dir) => {
                    #[cfg(windows)]
                    schedule_windows_post_exit_cleanup(&staged_dir);
                    #[cfg(not(windows))]
                    let _ = fs::remove_dir_all(&staged_dir);
                    println!("  ✓ 已彻底清理 ~/.rift 目录（退出后自动清理临时副本）");
                }
                PurgeOutcome::ScheduledDelayedCleanup(remaining) => {
                    #[cfg(windows)]
                    {
                        schedule_windows_post_exit_cleanup(&remaining);
                        if has_other_rift_processes() {
                            println!(
                                "  ⚠ 部分文件仍被运行中的旧终端占用：{}",
                                remaining.display()
                            );
                            println!(
                                "    关闭所有旧终端后如仍有残留，请运行: Remove-Item -Recurse -Force \"{}\"",
                                remaining.display()
                            );
                        } else {
                            println!(
                                "  ✓ 已安排退出后自动清理残留目录: {}",
                                remaining.display()
                            );
                        }
                    }
                    #[cfg(not(windows))]
                    {
                        println!(
                            "  ⚠ 未能完全删除（请检查权限）: {}",
                            remaining.display()
                        );
                    }
                }
            }
        }
    } else {
        println!("  提示：如需连同程序、~/.rift 配置目录与 PATH 一并彻底删除，请运行 `rift uninstall --purge`。");
    }

    #[cfg(windows)]
    if has_other_rift_processes() {
        println!("  ℹ 当前或其它已打开的旧终端仍由旧 rift 进程托管；关闭后新开终端即完全脱离 Rift。");
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

    #[test]
    fn uninstall_prune_claude_hooks_removes_empty_hooks_object() {
        let mut settings = json!({
            "model": "opus",
            "theme": "dark"
        });
        merge_claude_hooks(&mut settings, r"C:\Users\7\.rift\bin\rift.exe");
        assert!(settings.get("hooks").is_some());

        assert!(prune_claude_hooks(&mut settings));
        assert!(
            settings.get("hooks").is_none(),
            "empty hooks object should be removed completely"
        );
        assert_eq!(settings["model"], "opus");
        assert_eq!(settings["theme"], "dark");
    }

    #[test]
    fn uninstall_prune_claude_hooks_preserves_user_hooks_and_unrelated_files() {
        let mut settings = json!({
            "hooks": {
                "Notification": [
                    { "matcher": "*", "hooks": [{ "type": "command", "command": "echo keep-me" }] }
                ],
                "CustomEvent": []
            }
        });

        // No rift hooks yet -> untouched
        assert!(!prune_claude_hooks(&mut settings));
        assert!(settings["hooks"].get("CustomEvent").is_some());

        // Install rift hooks then prune -> user hook & CustomEvent survive, rift-only events removed
        merge_claude_hooks(&mut settings, "/usr/local/bin/rift");
        assert!(prune_claude_hooks(&mut settings));
        let hooks = settings["hooks"].as_object().expect("hooks object retained");
        assert_eq!(hooks["Notification"].as_array().unwrap().len(), 1);
        assert!(hooks.contains_key("CustomEvent"));
        assert!(!hooks.contains_key("Stop"));
        assert!(!hooks.contains_key("PreToolUse"));
        assert!(!hooks.contains_key("UserPromptSubmit"));
    }

    #[test]
    fn uninstall_remove_path_entry_handles_case_quotes_and_trailing_slashes() {
        let path_val = r#"C:\Windows\System32;"C:\USERS\7\.rift\bin\";C:\Users\7\.cargo\bin;C:/Users/7/.rift/bin"#;
        let updated = remove_path_entry(path_val, r"C:\Users\7\.rift\bin")
            .expect("should remove matching entries");
        assert_eq!(updated, r"C:\Windows\System32;C:\Users\7\.cargo\bin");

        // Idempotent when target no longer exists
        assert_eq!(remove_path_entry(&updated, r"C:\Users\7\.rift\bin"), None);
    }

    #[test]
    fn uninstall_remove_marked_block_deletes_file_if_empty_and_preserves_user_content() {
        let base = std::env::temp_dir().join(format!(
            "rift-setup-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&base).unwrap();

        let only_rift = base.join("only_rift.ps1");
        let block = format!("{MARKER_START}\necho rift\n{MARKER_END}\n");
        write_marked_block(&only_rift, &block).unwrap();
        assert!(remove_marked_block(&only_rift).unwrap());
        assert!(
            !only_rift.exists(),
            "profile created solely for rift hook should be deleted once empty"
        );

        let with_user = base.join("with_user.ps1");
        fs::write(&with_user, "function myfn { echo hi }\n").unwrap();
        write_marked_block(&with_user, &block).unwrap();
        assert!(remove_marked_block(&with_user).unwrap());
        assert_eq!(
            fs::read_to_string(&with_user).unwrap(),
            "function myfn { echo hi }\n"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn uninstall_purge_removes_rift_dir_and_external_binary() {
        let base = std::env::temp_dir().join(format!(
            "rift-purge-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let rift_dir = base.join(".rift");
        let ext_bin = base.join(".local").join("bin").join("rift");
        fs::create_dir_all(rift_dir.join("uploads")).unwrap();
        fs::create_dir_all(ext_bin.parent().unwrap()).unwrap();
        fs::write(rift_dir.join("config.json"), "{}").unwrap();
        fs::write(rift_dir.join("uploads").join("a.png"), b"png").unwrap();
        fs::write(&ext_bin, b"bin").unwrap();

        let outcome = purge_install_artifacts(&rift_dir, Some(&ext_bin), &base.join("tmp"));
        assert_eq!(outcome, PurgeOutcome::Removed);
        assert!(!rift_dir.exists());
        assert!(!ext_bin.exists());

        // Idempotent second run
        let outcome2 = purge_install_artifacts(&rift_dir, Some(&ext_bin), &base.join("tmp"));
        assert_eq!(outcome2, PurgeOutcome::NothingToRemove);

        let _ = fs::remove_dir_all(&base);
    }
}
