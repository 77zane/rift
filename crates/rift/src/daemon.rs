use crate::config::{default_shell, normalize_ws_url, platform_tag, RiftConfig};
use crate::protocol::ControlMessage;
use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use std::process::{Command, Stdio};
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub fn spawn_detached_session(
    relay: &str,
    host: &str,
    secret: &str,
    shell: Option<String>,
    cwd: Option<String>,
) {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return,
    };
    let target_shell = shell.unwrap_or_else(|| default_shell(""));
    let mut cmd = Command::new(exe);
    cmd.arg("--relay")
        .arg(relay)
        .arg("--host")
        .arg(host)
        .arg("--no-local");
    if !secret.is_empty() {
        cmd.arg("--secret").arg(secret);
    }
    cmd.arg("--").arg(target_shell);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const DETACHED_PROCESS: u32 = 0x00000008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }

    let _ = cmd.spawn();
}

pub async fn run_daemon(cfg: RiftConfig) -> Result<()> {
    let ws_url = normalize_ws_url(&cfg.relay, "/ws/agent");
    println!(
        "[rift daemon] host={} relay={} (keeps host online for remote `+` spawn)",
        cfg.host, ws_url
    );

    let mut backoff = Duration::from_secs(1);
    loop {
        match connect_async(&ws_url).await {
            Ok((ws_stream, _)) => {
                backoff = Duration::from_secs(1);
                let (mut write, mut read) = ws_stream.split();
                let reg = ControlMessage::HostOnline {
                    host_id: cfg.host.clone(),
                    host_name: cfg.host.clone(),
                    platform: platform_tag().to_string(),
                    secret: if cfg.secret.is_empty() {
                        None
                    } else {
                        Some(cfg.secret.clone())
                    },
                };
                if let Ok(text) = serde_json::to_string(&reg) {
                    if write.send(Message::Text(text.into())).await.is_err() {
                        tokio::time::sleep(backoff).await;
                        continue;
                    }
                }

                while let Some(Ok(msg)) = read.next().await {
                    match msg {
                        Message::Text(txt) => {
                            if let Ok(ControlMessage::HostSpawn {
                                host_id,
                                shell,
                                cwd,
                            }) = serde_json::from_str::<ControlMessage>(&txt)
                            {
                                if host_id == cfg.host {
                                    spawn_detached_session(
                                        &cfg.relay,
                                        &cfg.host,
                                        &cfg.secret,
                                        shell,
                                        cwd,
                                    );
                                }
                            }
                        }
                        Message::Ping(p) => {
                            let _ = write.send(Message::Pong(p)).await;
                        }
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
            }
            Err(_) => {}
        }

        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(5));
    }
}
