use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiftConfig {
    pub relay: String,
    pub host: String,
    #[serde(default)]
    pub secret: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub shell: String,
}

fn detect_local_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    let ip = sock.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        return None;
    }
    Some(ip.to_string())
}

impl Default for RiftConfig {
    fn default() -> Self {
        let host = detect_local_ip()
            .or_else(|| hostname::get().ok().and_then(|s| s.into_string().ok()))
            .unwrap_or_else(|| "127.0.0.1".to_string());
        Self {
            relay: "ws://127.0.0.1:7700".to_string(),
            host,
            secret: String::new(),
            token: String::new(),
            shell: String::new(),
        }
    }
}

pub fn config_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("无法获取用户主目录")?;
    Ok(home.join(".rift").join("config.json"))
}

pub fn load_config() -> RiftConfig {
    let mut cfg = config_path()
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<RiftConfig>(&s).ok())
        .unwrap_or_default();

    if let Ok(v) = std::env::var("RIFT_RELAY") {
        if !v.is_empty() {
            cfg.relay = v;
        }
    }
    if let Ok(v) = std::env::var("RIFT_HOST") {
        if !v.is_empty() {
            cfg.host = v;
        }
    }
    if let Ok(v) = std::env::var("RIFT_SECRET") {
        if !v.is_empty() {
            cfg.secret = v;
        }
    }
    if let Ok(v) = std::env::var("RIFT_TOKEN") {
        if !v.is_empty() {
            cfg.token = v;
        }
    } else if let Ok(v) = std::env::var("WEB_TOKEN") {
        if !v.is_empty() {
            cfg.token = v;
        }
    }
    cfg
}

pub fn save_config(cfg: &RiftConfig) -> Result<PathBuf> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(cfg)?;
    fs::write(&path, json)?;
    Ok(path)
}

pub fn normalize_ws_url(base: &str, suffix: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with(suffix) {
        return trimmed.to_string();
    }
    if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}{suffix}")
    } else if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}{suffix}")
    } else {
        format!("{trimmed}{suffix}")
    }
}

pub fn default_shell(configured: &str) -> String {
    if !configured.is_empty() {
        return configured.to_string();
    }
    #[cfg(windows)]
    {
        if let Some(path_var) = std::env::var_os("PATH") {
            let dirs: Vec<PathBuf> = std::env::split_paths(&path_var).collect();
            for cand in ["pwsh.exe", "powershell.exe", "cmd.exe"] {
                if dirs.iter().any(|d| d.join(cand).is_file()) {
                    return cand.to_string();
                }
            }
        }
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

pub fn platform_tag() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}
