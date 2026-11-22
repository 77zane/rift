use crate::config::{normalize_ws_url, RiftConfig};
use crate::protocol::{
    decode_binary_frame, encode_binary_frame, ControlMessage, SessionInfo, FRAME_PTY_INPUT,
    FRAME_PTY_OUTPUT, FRAME_PTY_REPLAY,
};
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::io::{IsTerminal, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

struct RawModeGuard(bool);
impl Drop for RawModeGuard {
    fn drop(&mut self) {
        if self.0 {
            let _ = crossterm::terminal::disable_raw_mode();
        }
    }
}

fn prompt_line(prompt: &str) -> Result<String> {
    print!("{prompt}");
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    Ok(line.trim().to_string())
}

pub async fn run_attach(cfg: RiftConfig, target: Option<String>) -> Result<()> {
    let ws_url = normalize_ws_url(&cfg.relay, "/ws/web");
    let (ws_stream, _) = connect_async(&ws_url)
        .await
        .with_context(|| format!("连接中转服务失败: {ws_url}"))?;
    let (mut write, mut read) = ws_stream.split();

    if !cfg.token.is_empty() {
        let auth = ControlMessage::WebAuth {
            token: Some(cfg.token.clone()),
        };
        write
            .send(Message::Text(serde_json::to_string(&auth)?.into()))
            .await?;
    }

    // Wait for session list (prompting for token if auth is required)
    let hosts = loop {
        match tokio::time::timeout(Duration::from_millis(800), read.next()).await {
            Ok(Some(Ok(Message::Text(txt)))) => {
                if let Ok(msg) = serde_json::from_str::<ControlMessage>(&txt) {
                    match msg {
                        ControlMessage::WebList { hosts } => break hosts,
                        ControlMessage::WebAuthErr { message } => {
                            eprintln!("[rift] {message}");
                            let t = prompt_line("请输入访问密钥 WEB_TOKEN: ")?;
                            let auth = ControlMessage::WebAuth { token: Some(t) };
                            write
                                .send(Message::Text(serde_json::to_string(&auth)?.into()))
                                .await?;
                        }
                        _ => {}
                    }
                }
            }
            Err(_) => {
                let t = prompt_line("请输入访问密钥 WEB_TOKEN: ")?;
                let auth = ControlMessage::WebAuth { token: Some(t) };
                write
                    .send(Message::Text(serde_json::to_string(&auth)?.into()))
                    .await?;
            }
            _ => {
                anyhow::bail!("连接已关闭");
            }
        }
    };

    let all: Vec<SessionInfo> = hosts.into_iter().flat_map(|h| h.sessions).collect();
    if all.is_empty() {
        println!("[rift] 当前没有在线终端会话。");
        return Ok(());
    }

    let chosen = if let Some(ref query) = target {
        all.iter()
            .find(|s| s.session_id == *query || s.session_id.starts_with(query))
            .cloned()
            .with_context(|| format!("未找到会话: {query}"))?
    } else if all.len() == 1 {
        all[0].clone()
    } else {
        println!("\n在线终端会话列表：");
        for (i, s) in all.iter().enumerate() {
            println!(
                "  [{}] {} / {}  ({} · {}x{} · id={})",
                i + 1,
                s.host_name,
                s.title,
                s.shell,
                s.cols,
                s.rows,
                s.session_id
            );
        }
        let ans = prompt_line("\n输入序号接管（直接回车选最后一个，q 退出）: ")?;
        if ans.eq_ignore_ascii_case("q") {
            return Ok(());
        }
        let idx = if ans.is_empty() {
            all.len() - 1
        } else {
            ans.parse::<usize>()
                .ok()
                .and_then(|n| n.checked_sub(1))
                .context("无效序号")?
        };
        all.get(idx).cloned().context("序号越界")?
    };

    let sid = chosen.session_id.clone();
    print!(
        "\x1b[2J\x1b[H[rift] 已接管 {} / {} ({}) — 按 Ctrl+] 脱离（后台继续运行）\r\n",
        chosen.host_name, chosen.title, sid
    );
    std::io::stdout().flush()?;

    let attach_msg = ControlMessage::WebAttach {
        session_id: sid.clone(),
    };
    write
        .send(Message::Text(serde_json::to_string(&attach_msg)?.into()))
        .await?;

    let local_tty = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    if local_tty {
        let _ = crossterm::terminal::enable_raw_mode();
    }
    let _raw_guard = RawModeGuard(local_tty);

    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let detached = Arc::new(AtomicBool::new(false));
    {
        let detached = Arc::clone(&detached);
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin();
            let mut buf = [0u8; 512];
            while !detached.load(Ordering::Relaxed) {
                match stdin.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if buf[..n].contains(&0x1d) {
                            detached.store(true, Ordering::Relaxed);
                            let _ = in_tx.send(Vec::new());
                            break;
                        }
                        if in_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }

    let mut stdout = std::io::stdout();
    loop {
        tokio::select! {
            chunk = in_rx.recv() => {
                match chunk {
                    Some(bytes) if bytes.is_empty() => {
                        let detach = ControlMessage::WebDetach { session_id: sid.clone() };
                        let _ = write.send(Message::Text(serde_json::to_string(&detach)?.into())).await;
                        let _ = write.close().await;
                        break;
                    }
                    Some(bytes) => {
                        let frame = encode_binary_frame(FRAME_PTY_INPUT, &sid, &bytes);
                        if write.send(Message::Binary(frame.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Binary(bin))) => {
                        if let Some((ftype, frame_sid, payload)) = decode_binary_frame(&bin) {
                            if frame_sid == sid && (ftype == FRAME_PTY_OUTPUT || ftype == FRAME_PTY_REPLAY) {
                                let _ = stdout.write_all(payload);
                                let _ = stdout.flush();
                            }
                        }
                    }
                    Some(Ok(Message::Text(txt))) => {
                        if let Ok(ControlMessage::WebList { hosts }) = serde_json::from_str::<ControlMessage>(&txt) {
                            let alive = hosts.iter().any(|h| h.sessions.iter().any(|s| s.session_id == sid));
                            if !alive {
                                detached.store(true, Ordering::Relaxed);
                                drop(_raw_guard);
                                println!("\r\n[rift] 远端会话已关闭。");
                                return Ok(());
                            }
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = write.send(Message::Pong(p)).await;
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }

    detached.store(true, Ordering::Relaxed);
    drop(_raw_guard);
    println!("\r\n[rift] 已脱离会话（后台进程继续运行）。");
    Ok(())
}
