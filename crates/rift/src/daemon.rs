use crate::config::{default_shell, normalize_ws_url, platform_tag, RiftConfig};
use crate::protocol::ControlMessage;
use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
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
        match tokio::time::timeout(Duration::from_secs(15), connect_async(&ws_url)).await {
            Ok(Ok((ws_stream, _))) => {
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

                let mut last_rx = Instant::now();
                let mut ping_tick = tokio::time::interval(Duration::from_secs(20));
                ping_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                ping_tick.tick().await; // consume immediate first tick

                loop {
                    tokio::select! {
                        _ = ping_tick.tick() => {
                            if last_rx.elapsed() > Duration::from_secs(60) {
                                // Half-open TCP connection (e.g. after sleep/wake or network switch)
                                break;
                            }
                            if write.send(Message::Ping(Vec::new().into())).await.is_err() {
                                break;
                            }
                        }
                        incoming = read.next() => {
                            match incoming {
                                Some(Ok(Message::Text(txt))) => {
                                    last_rx = Instant::now();
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
                                Some(Ok(Message::Ping(p))) => {
                                    last_rx = Instant::now();
                                    if write.send(Message::Pong(p)).await.is_err() {
                                        break;
                                    }
                                }
                                Some(Ok(Message::Pong(_))) => {
                                    last_rx = Instant::now();
                                }
                                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                                Some(Ok(_)) => {
                                    last_rx = Instant::now();
                                }
                            }
                        }
                    }
                }
            }
            Ok(Err(_)) | Err(_) => {}
        }

        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(5));
    }
}
