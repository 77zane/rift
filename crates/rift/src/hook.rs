use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

const MARKER_START: &str = "# >>> rift auto-mirror hook >>>";
const MARKER_END: &str = "# <<< rift auto-mirror hook <<<";

fn ps_profile_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("无法获取用户主目录")?;
    #[cfg(windows)]
    {
        Ok(home
            .join("Documents")
            .join("PowerShell")
            .join("Microsoft.PowerShell_profile.ps1"))
    }
    #[cfg(not(windows))]
    {
        Ok(home.join(".bashrc"))
    }
}

pub fn install_hook() -> Result<()> {
    let exe = std::env::current_exe().context("无法获取 rift 可执行文件路径")?;
    let exe_str = exe.to_string_lossy();
    let profile = ps_profile_path()?;

    if let Some(parent) = profile.parent() {
        fs::create_dir_all(parent)?;
    }

    let existing = fs::read_to_string(&profile).unwrap_or_default();
    let cleaned = strip_hook_block(&existing);

    #[cfg(windows)]
    let block = format!(
        "{MARKER_START}\r\nif (-not $env:RIFT_SESSION_ID -and -not $env:RIFT_DISABLE -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {{\r\n    & \"{exe_str}\" -- pwsh.exe\r\n    exit $LASTEXITCODE\r\n}}\r\n{MARKER_END}\r\n"
    );

    #[cfg(not(windows))]
    let block = format!(
        "{MARKER_START}\nif [ -t 0 ] && [ -z \"$RIFT_SESSION_ID\" ] && [ -z \"$RIFT_DISABLE\" ]; then\n  exec \"{exe_str}\" -- \"$SHELL\"\nfi\n{MARKER_END}\n"
    );

    let updated = if cleaned.trim().is_empty() {
        block
    } else {
        format!("{block}\n{cleaned}")
    };

    fs::write(&profile, updated)?;
    println!("[rift hook] 已成功安装自动接入钩子到: {}", profile.display());
    println!("[rift hook] 以后新开终端将自动无感接入 Rift（设置 RIFT_DISABLE=1 可临时跳过）。");
    Ok(())
}

pub fn uninstall_hook() -> Result<()> {
    let profile = ps_profile_path()?;
    if !profile.exists() {
        println!("[rift hook] 未发现配置文件: {}", profile.display());
        return Ok(());
    }
    let existing = fs::read_to_string(&profile)?;
    let cleaned = strip_hook_block(&existing);
    fs::write(&profile, cleaned)?;
    println!("[rift hook] 已从 {} 干净移除 Rift 钩子。", profile.display());
    Ok(())
}

fn strip_hook_block(content: &str) -> String {
    if let (Some(start), Some(end)) = (content.find(MARKER_START), content.find(MARKER_END)) {
        let after_end = end + MARKER_END.len();
        let before = &content[..start];
        let after = content[after_end..].trim_start_matches(['\r', '\n']);
        format!("{before}{after}")
    } else {
        content.to_string()
    }
}
