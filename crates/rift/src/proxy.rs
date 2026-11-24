use crate::config::{default_shell, normalize_ws_url, platform_tag, RiftConfig};
use crate::console::RawConsoleGuard;
#[cfg(windows)]
use crate::console::{normalize_win_conpty_input, WinOutputKeyboardFilter};
use crate::daemon::spawn_detached_session;
use crate::protocol::{
    decode_binary_frame, encode_binary_frame, ByteRingBuffer, ControlMessage, FRAME_PTY_INPUT,
    FRAME_PTY_OUTPUT, FRAME_PTY_REPLAY,
};
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use rand::Rng;
use std::io::{IsTerminal, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        protocol::{frame::coding::CloseCode, CloseFrame},
        Message,
    },
};

pub struct ProxyRunOptions {
    pub config: RiftConfig,
    pub title: Option<String>,
    pub no_local: bool,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub command: Vec<String>,
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for b in input.bytes() {
        let val = match b {
            b'A'..=b'Z' => (b - b'A') as u32,
            b'a'..=b'z' => (b - b'a' + 26) as u32,
            b'0'..=b'9' => (b - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' | b' ' | b'\t' => continue,
            _ => return None,
        };
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

fn cleanup_old_uploads() {
    let Some(dir) = dirs::home_dir().map(|h| h.join(".rift").join("uploads")) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let max_age = Duration::from_secs(7 * 24 * 3600);
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("paste-") {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if now.duration_since(modified).unwrap_or_default() > max_age {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }
}

fn save_pasted_image(mime: &str, data_b64: &str) -> Option<String> {
    let bytes = decode_base64(data_b64)?;
    if bytes.is_empty() || bytes.len() > 12 * 1024 * 1024 {
        return None;
    }
    let ext = match mime.to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        _ => "png",
    };
    let dir = dirs::home_dir()?.join(".rift").join("uploads");
    std::fs::create_dir_all(&dir).ok()?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let rand_suffix: u16 = rand::thread_rng().gen();
    let file_path = dir.join(format!("paste-{ts}-{rand_suffix:04x}.{ext}"));
    std::fs::write(&file_path, bytes).ok()?;
    Some(file_path.to_string_lossy().to_string())
}

fn gen_session_id() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 6] = rng.gen();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn default_dir_title(cwd: &str) -> String {
    if let Some(home) = dirs::home_dir() {
        if Path::new(cwd) == home {
            return "~".to_string();
        }
    }
    Path::new(cwd)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| cwd.to_string())
}

fn is_generic_shell_title(title: &str) -> bool {
    let lower = title.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "pwsh"
            | "pwsh.exe"
            | "powershell"
            | "powershell.exe"
            | "windows powershell"
            | "cmd"
            | "cmd.exe"
            | "command prompt"
            | "bash"
            | "zsh"
            | "sh"
    )
}

fn extract_osc_title(chunk: &str) -> Option<String> {
    let bytes = chunk.as_bytes();
    let mut i = 0;
    let mut last: Option<String> = None;
    while i + 4 < bytes.len() {
        if bytes[i] == 0x1b
            && bytes[i + 1] == b']'
            && (bytes[i + 2] == b'0' || bytes[i + 2] == b'2')
            && bytes[i + 3] == b';'
        {
            let start = i + 4;
            let mut end = start;
            while end < bytes.len() && end - start < 220 {
                if bytes[end] == 0x07 {
                    break;
                }
                if bytes[end] == 0x1b && end + 1 < bytes.len() && bytes[end + 1] == b'\\' {
                    break;
                }
                end += 1;
            }
            if end < bytes.len() {
                if let Ok(raw) = std::str::from_utf8(&bytes[start..end]) {
                    let mut title = raw.trim().to_string();
                    if !title.is_empty() {
                        if title.len() > 6
                            && title.as_bytes()[1] == b':'
                            && title.to_ascii_lowercase().ends_with(".exe")
                        {
                            if let Some(name) = title
                                .rsplit(['\\', '/'])
                                .next()
                                .filter(|s| !s.is_empty())
                            {
                                title = name.to_string();
                            }
                        }
                        if !is_generic_shell_title(&title) {
                            last = Some(title);
                        }
                    }
                }
                i = end + 1;
                continue;
            }
        }
        i += 1;
    }
    last
}

enum OutboundEvent {
    Output(Vec<u8>),
    Title(String),
    Size(u16, u16),
}

pub async fn run_proxy(opts: ProxyRunOptions) -> Result<i32> {
    std::thread::spawn(cleanup_old_uploads);
    // Start TLS + WebSocket handshake in parallel with PTY/shell startup to cut `+` spawn latency.
    let ws_url = normalize_ws_url(&opts.config.relay, "/ws/agent");
    let ws_url_prefetch = ws_url.clone();
    let mut initial_connect = Some(tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(15), connect_async(&ws_url_prefetch)).await
    }));
    let session_id = gen_session_id();
    let shell_bin = opts
        .command
        .first()
        .cloned()
        .unwrap_or_else(|| default_shell(&opts.config.shell));
    let shell_args: Vec<String> = if opts.command.len() > 1 {
        opts.command[1..].to_vec()
    } else {
        Vec::new()
    };
    let shell_label = Path::new(&shell_bin)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| shell_bin.clone());

    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());

    let local_tty = !opts.no_local && std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    let (detected_cols, detected_rows) = if local_tty {
        crossterm::terminal::size().unwrap_or((120, 32))
    } else {
        (120, 32)
    };
    let init_cols = opts.cols.unwrap_or(detected_cols).max(20);
    let init_rows = opts.rows.unwrap_or(detected_rows).max(5);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: init_rows,
            cols: init_cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("创建系统 PTY 失败")?;

    let mut cmd = CommandBuilder::new(&shell_bin);
    for a in &shell_args {
        cmd.arg(a);
    }
    cmd.cwd(&cwd);
    cmd.env("RIFT_SESSION_ID", &session_id);
    cmd.env("RIFT_HOST", &opts.config.host);
    if std::env::var_os("TERM").is_none() {
        cmd.env("TERM", "xterm-256color");
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .with_context(|| format!("启动终端失败: {shell_bin}"))?;
    let mut killer = child.clone_killer();
    drop(pair.slave);

    let mut pty_reader = pair.master.try_clone_reader().context("克隆 PTY 读取端失败")?;
    let pty_writer = Arc::new(Mutex::new(
        pair.master.take_writer().context("获取 PTY 写入端失败")?,
    ));
    let pty_master = Arc::new(Mutex::new(pair.master));

    let ring = Arc::new(Mutex::new(ByteRingBuffer::new(2 * 1024 * 1024)));
    let default_title = default_dir_title(&cwd);
    let custom_title = Arc::new(AtomicBool::new(opts.title.is_some()));
    let current_title = Arc::new(Mutex::new(
        opts.title.clone().unwrap_or_else(|| default_title.clone()),
    ));
    let current_size = Arc::new(Mutex::new((init_cols, init_rows)));
    let shutting_down = Arc::new(AtomicBool::new(false));

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<OutboundEvent>();

    let _raw_guard = RawConsoleGuard::enter(local_tty);

    // 1. PTY output -> local stdout + RingBuffer + Relay channel
    {
        let ring = Arc::clone(&ring);
        let current_title = Arc::clone(&current_title);
        let custom_title = Arc::clone(&custom_title);
        let out_tx = out_tx.clone();
        let no_local = opts.no_local;
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut stdout = std::io::stdout();
            #[cfg(windows)]
            let mut win_out_filter = WinOutputKeyboardFilter::new();
            while let Ok(n) = pty_reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let slice = &buf[..n];
                if !no_local {
                    #[cfg(windows)]
                    {
                        let filtered = win_out_filter.filter(slice);
                        if !filtered.is_empty() {
                            let _ = stdout.write_all(&filtered);
                            let _ = stdout.flush();
                        }
                    }
                    #[cfg(not(windows))]
                    {
                        let _ = stdout.write_all(slice);
                        let _ = stdout.flush();
                    }
                }
                if let Ok(mut rb) = ring.lock() {
                    rb.push(slice);
                }
                if !custom_title.load(Ordering::Relaxed) {
                    let text = String::from_utf8_lossy(slice);
                    if let Some(new_title) = extract_osc_title(&text) {
                        let mut changed = false;
                        if let Ok(mut t) = current_title.lock() {
                            if *t != new_title {
                                *t = new_title.clone();
                                changed = true;
                            }
                        }
                        if changed {
                            let _ = out_tx.send(OutboundEvent::Title(new_title));
                        }
                    }
                }
                let _ = out_tx.send(OutboundEvent::Output(slice.to_vec()));
            }
        });
    }

    // 2. Local stdin -> PTY writer
    if local_tty {
        {
            let pty_writer = Arc::clone(&pty_writer);
            let shutting_down = Arc::clone(&shutting_down);
            std::thread::spawn(move || {
                let mut stdin = std::io::stdin();
                let mut buf = [0u8; 1024];
                while !shutting_down.load(Ordering::Relaxed) {
                    match stdin.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            #[cfg(windows)]
                            let normalized = normalize_win_conpty_input(&buf[..n]);
                            #[cfg(windows)]
                            let to_write = normalized.as_slice();
                            #[cfg(not(windows))]
                            let to_write = &buf[..n];
                            if !to_write.is_empty() {
                                if let Ok(mut w) = pty_writer.lock() {
                                    let _ = w.write_all(to_write);
                                    let _ = w.flush();
                                }
                            }
                        }
                    }
                }
            });
        }

        // 3. Local terminal resize poller (250ms)
        // Track the physical local window size separately (`last_local`) so a remote
        // Web `TermResize` is not immediately reverted 250ms later; only when the user
        // actually resizes the local terminal window does local take back control.
        {
            let pty_master = Arc::clone(&pty_master);
            let current_size = Arc::clone(&current_size);
            let shutting_down = Arc::clone(&shutting_down);
            let out_tx = out_tx.clone();
            std::thread::spawn(move || {
                let mut last_local = (init_cols, init_rows);
                while !shutting_down.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(250));
                    if let Ok((cols, rows)) = crossterm::terminal::size() {
                        if cols >= 20 && rows >= 5 && (cols != last_local.0 || rows != last_local.1) {
                            last_local = (cols, rows);
                            let mut changed = false;
                            if let Ok(mut sz) = current_size.lock() {
                                if sz.0 != cols || sz.1 != rows {
                                    *sz = (cols, rows);
                                    changed = true;
                                }
                            }
                            if changed {
                                if let Ok(m) = pty_master.lock() {
                                    let _ = m.resize(PtySize {
                                        rows,
                                        cols,
                                        pixel_width: 0,
                                        pixel_height: 0,
                                    });
                                }
                                let _ = out_tx.send(OutboundEvent::Size(cols, rows));
                            }
                        }
                    }
                }
            });
        }
    }

    // 4. Child exit watcher
    let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<i32>();
    std::thread::spawn(move || {
        let code = child
            .wait()
            .map(|s| s.exit_code() as i32)
            .unwrap_or(0);
        let _ = exit_tx.send(code);
    });

    // 5. Async WebSocket relay loop (never kills local shell on network error)
    let cfg = opts.config.clone();
    let sid_for_ws = session_id.clone();
    let ring_for_ws = Arc::clone(&ring);
    let title_for_ws = Arc::clone(&current_title);
    let custom_title_for_ws = Arc::clone(&custom_title);
    let size_for_ws = Arc::clone(&current_size);
    let writer_for_ws = Arc::clone(&pty_writer);
    let master_for_ws = Arc::clone(&pty_master);
    let shutting_for_ws = Arc::clone(&shutting_down);
    let (close_tx, mut close_rx) = tokio::sync::oneshot::channel::<()>();

    let ws_task = tokio::spawn(async move {
        let mut backoff = Duration::from_secs(1);
        loop {
            if shutting_for_ws.load(Ordering::Relaxed) {
                break;
            }
            let conn_res = if let Some(handle) = initial_connect.take() {
                match handle.await {
                    Ok(res) => res,
                    Err(_) => {
                        tokio::time::timeout(Duration::from_secs(15), connect_async(&ws_url)).await
                    }
                }
            } else {
                tokio::time::timeout(Duration::from_secs(15), connect_async(&ws_url)).await
            };
            match conn_res {
                Ok(Ok((ws_stream, _))) => {
                    backoff = Duration::from_secs(1);
                    let (mut write, mut read) = ws_stream.split();
                    let (cols, rows) = size_for_ws.lock().map(|s| *s).unwrap_or((init_cols, init_rows));
                    let title = title_for_ws.lock().map(|t| t.clone()).unwrap_or_else(|_| shell_label.clone());

                    let reg = ControlMessage::AgentRegister {
                        host_id: cfg.host.clone(),
                        host_name: cfg.host.clone(),
                        platform: platform_tag().to_string(),
                        session_id: sid_for_ws.clone(),
                        title,
                        shell: shell_label.clone(),
                        cwd: cwd.clone(),
                        cols,
                        rows,
                        headless: opts.no_local,
                        custom_title: custom_title_for_ws.load(Ordering::Relaxed),
                        secret: if cfg.secret.is_empty() {
                            None
                        } else {
                            Some(cfg.secret.clone())
                        },
                    };
                    if let Ok(txt) = serde_json::to_string(&reg) {
                        if write.send(Message::Text(txt.into())).await.is_err() {
                            tokio::time::sleep(backoff).await;
                            continue;
                        }
                    }

                    // Drain queued pre-reconnect events before snapshot (ring already holds all of them)
                    while out_rx.try_recv().is_ok() {}

                    // Upload Ring Buffer snapshot so relay restores screen even after relay restart
                    let snap = ring_for_ws.lock().map(|rb| rb.snapshot()).unwrap_or_default();
                    if !snap.is_empty() {
                        let frame = encode_binary_frame(FRAME_PTY_REPLAY, &sid_for_ws, &snap);
                        let _ = write.send(Message::Binary(frame.into())).await;
                    }

                    let mut last_rx = Instant::now();
                    let mut awaiting_pong = false;
                    let mut missed_pongs: u32 = 0;
                    let mut hb = tokio::time::interval(Duration::from_secs(15));
                    hb.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                    hb.tick().await; // consume immediate first tick
                    loop {
                        tokio::select! {
                            _ = &mut close_rx => {
                                let _ = write.send(Message::Close(Some(CloseFrame {
                                    code: CloseCode::Normal,
                                    reason: "shell_exit".into(),
                                }))).await;
                                let _ = write.flush().await;
                                return;
                            }
                            _ = hb.tick() => {
                                if awaiting_pong {
                                    missed_pongs += 1;
                                }
                                if missed_pongs >= 2 || last_rx.elapsed() > Duration::from_secs(45) {
                                    // Half-open TCP connection after sleep/wake or Wi-Fi roam -> reconnect now
                                    break;
                                }
                                let msg = ControlMessage::AgentHeartbeat { session_id: sid_for_ws.clone() };
                                if let Ok(txt) = serde_json::to_string(&msg) {
                                    if write.send(Message::Text(txt.into())).await.is_err() {
                                        break;
                                    }
                                }
                                if write.send(Message::Ping(Vec::new().into())).await.is_err() {
                                    break;
                                }
                                awaiting_pong = true;
                            }
                            ev = out_rx.recv() => {
                                match ev {
                                    Some(OutboundEvent::Output(bytes)) => {
                                        let frame = encode_binary_frame(FRAME_PTY_OUTPUT, &sid_for_ws, &bytes);
                                        if write.send(Message::Binary(frame.into())).await.is_err() {
                                            break;
                                        }
                                    }
                                    Some(OutboundEvent::Title(t)) => {
                                        if !custom_title_for_ws.load(Ordering::Relaxed) {
                                            let msg = ControlMessage::AgentUpdate {
                                                session_id: sid_for_ws.clone(),
                                                title: Some(t),
                                                cwd: None,
                                                cols: None,
                                                rows: None,
                                            };
                                            if let Ok(txt) = serde_json::to_string(&msg) {
                                                let _ = write.send(Message::Text(txt.into())).await;
                                            }
                                        }
                                    }
                                    Some(OutboundEvent::Size(c, r)) => {
                                        let msg = ControlMessage::AgentUpdate {
                                            session_id: sid_for_ws.clone(),
                                            title: None,
                                            cwd: None,
                                            cols: Some(c),
                                            rows: Some(r),
                                        };
                                        if let Ok(txt) = serde_json::to_string(&msg) {
                                            let _ = write.send(Message::Text(txt.into())).await;
                                        }
                                    }
                                    None => break,
                                }
                            }
                            incoming = read.next() => {
                                match incoming {
                                    Some(Ok(Message::Binary(bin))) => {
                                        last_rx = Instant::now();
                                        awaiting_pong = false;
                                        missed_pongs = 0;
                                        if let Some((ftype, sid, payload)) = decode_binary_frame(&bin) {
                                            if ftype == FRAME_PTY_INPUT && sid == sid_for_ws {
                                                #[cfg(windows)]
                                                let normalized = normalize_win_conpty_input(payload);
                                                #[cfg(windows)]
                                                let to_write = normalized.as_slice();
                                                #[cfg(not(windows))]
                                                let to_write = payload;
                                                if !to_write.is_empty() {
                                                    if let Ok(mut w) = writer_for_ws.lock() {
                                                        let _ = w.write_all(to_write);
                                                        let _ = w.flush();
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    Some(Ok(Message::Text(txt))) => {
                                        last_rx = Instant::now();
                                        awaiting_pong = false;
                                        missed_pongs = 0;
                                        if let Ok(ctrl) = serde_json::from_str::<ControlMessage>(&txt) {
                                            match ctrl {
                                                ControlMessage::TermResize { session_id, cols, rows }
                                                    if session_id == sid_for_ws =>
                                                {
                                                    let mut changed = false;
                                                    if let Ok(mut sz) = size_for_ws.lock() {
                                                        if sz.0 != cols || sz.1 != rows {
                                                            *sz = (cols, rows);
                                                            changed = true;
                                                        }
                                                    }
                                                    if changed {
                                                        if let Ok(m) = master_for_ws.lock() {
                                                            let _ = m.resize(PtySize {
                                                                rows,
                                                                cols,
                                                                pixel_width: 0,
                                                                pixel_height: 0,
                                                            });
                                                        }
                                                        let upd = ControlMessage::AgentUpdate {
                                                            session_id: sid_for_ws.clone(),
                                                            title: None,
                                                            cwd: None,
                                                            cols: Some(cols),
                                                            rows: Some(rows),
                                                        };
                                                        if let Ok(s) = serde_json::to_string(&upd) {
                                                            let _ = write.send(Message::Text(s.into())).await;
                                                        }
                                                    }
                                                }
                                                ControlMessage::HostSpawn { host_id, shell, cwd: req_cwd }
                                                    if host_id == cfg.host =>
                                                {
                                                    spawn_detached_session(
                                                        &cfg.relay,
                                                        &cfg.host,
                                                        &cfg.secret,
                                                        shell,
                                                        req_cwd,
                                                    );
                                                }
                                                ControlMessage::TermRename { session_id, title }
                                                    if session_id == sid_for_ws =>
                                                {
                                                    let next: String = title.trim().chars().take(64).collect();
                                                    if !next.is_empty() {
                                                        if let Ok(mut t) = title_for_ws.lock() {
                                                            *t = next;
                                                        }
                                                        custom_title_for_ws.store(true, Ordering::Relaxed);
                                                    }
                                                }
                                                ControlMessage::TermClose { session_id }
                                                    if session_id == sid_for_ws =>
                                                {
                                                    let _ = killer.kill();
                                                    shutting_for_ws.store(true, Ordering::Relaxed);
                                                    let _ = write.send(Message::Close(Some(CloseFrame {
                                                        code: CloseCode::Normal,
                                                        reason: "term_close".into(),
                                                    }))).await;
                                                    let _ = write.flush().await;
                                                    break;
                                                }
                                                ControlMessage::TermPasteImage { session_id, mime, data }
                                                    if session_id == sid_for_ws =>
                                                {
                                                    if let Some(saved_path) = save_pasted_image(&mime, &data) {
                                                        let to_write = if saved_path.contains(' ') {
                                                            format!("\"{saved_path}\" ")
                                                        } else {
                                                            format!("{saved_path} ")
                                                        };
                                                        if let Ok(mut w) = writer_for_ws.lock() {
                                                            let _ = w.write_all(to_write.as_bytes());
                                                            let _ = w.flush();
                                                        }
                                                    }
                                                }
                                                _ => {}
                                            }
                                        }
                                    }
                                    Some(Ok(Message::Ping(p))) => {
                                        last_rx = Instant::now();
                                        awaiting_pong = false;
                                        missed_pongs = 0;
                                        if write.send(Message::Pong(p)).await.is_err() {
                                            break;
                                        }
                                    }
                                    Some(Ok(Message::Pong(_))) => {
                                        last_rx = Instant::now();
                                        awaiting_pong = false;
                                        missed_pongs = 0;
                                    }
                                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                                    Some(Ok(_)) => {
                                        last_rx = Instant::now();
                                        awaiting_pong = false;
                                        missed_pongs = 0;
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(Err(_)) | Err(_) => {
                    // Drain queued output while offline so memory stays bounded
                    while out_rx.try_recv().is_ok() {}
                }
            }

            if shutting_for_ws.load(Ordering::Relaxed) {
                break;
            }
            tokio::select! {
                _ = &mut close_rx => break,
                _ = tokio::time::sleep(backoff) => {}
            }
            backoff = (backoff * 2).min(Duration::from_secs(5));
        }
    });

    let exit_code = exit_rx.await.unwrap_or(0);
    shutting_down.store(true, Ordering::Relaxed);
    let _ = close_tx.send(());
    let mut ws_task = ws_task;
    if tokio::time::timeout(Duration::from_millis(300), &mut ws_task)
        .await
        .is_err()
    {
        ws_task.abort();
    }
    Ok(exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_base64_handles_standard_whitespace_and_rejects_invalid() {
        assert_eq!(decode_base64("SGVsbG8sIFJpZnQh").as_deref(), Some(b"Hello, Rift!".as_slice()));
        assert_eq!(decode_base64("SGVs\r\nbG8=").as_deref(), Some(b"Hello".as_slice()));
        assert_eq!(decode_base64("not@valid!"), None);
    }

    #[test]
    fn extract_osc_title_filters_generic_shells_and_keeps_real_titles() {
        // Generic shell names & full Windows system32 exe paths must be ignored
        assert_eq!(extract_osc_title("\x1b]0;pwsh.exe\x07"), None);
        assert_eq!(
            extract_osc_title("\x1b]0;C:\\Windows\\System32\\cmd.exe\x07"),
            None
        );
        // Real project/app title using BEL or ST terminator must be captured
        assert_eq!(
            extract_osc_title("\x1b]0;agy — agentshare\x07"),
            Some("agy — agentshare".to_string())
        );
        assert_eq!(
            extract_osc_title("\x1b]2;build-server\x1b\\"),
            Some("build-server".to_string())
        );
    }

    #[test]
    fn default_dir_title_uses_leaf_directory_name() {
        assert_eq!(default_dir_title("/tmp/my-project"), "my-project");
    }
}
