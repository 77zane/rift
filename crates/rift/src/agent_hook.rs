use crate::config::{normalize_ws_url, RiftConfig};
use crate::protocol::ControlMessage;
use futures_util::SinkExt;
use std::io::{IsTerminal, Read};
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

fn normalize_state(event: &str) -> &'static str {
    match event.to_ascii_lowercase().as_str() {
        "running" | "submit" | "prompt" | "agent.prompt.submit" | "thinking" => "running",
        "tool" | "tool.starting" | "agent.tool.starting" | "pre_tool_use" => "tool",
        "waiting" | "ask" | "notification" | "attention" => "waiting",
        "idle" | "stop" | "agent.stop" | "done" => "idle",
        _ => "running",
    }
}

/// Fire-and-forget active state reporter invoked by AI CLI hooks (agy / claude / codex).
/// Must ALWAYS return quickly (<600ms) and silently if not inside a Rift session.
pub async fn run_agent_hook(
    cfg: RiftConfig,
    agent: String,
    event: String,
    session_override: Option<String>,
    print_json: bool,
    decision: Option<String>,
) {
    let emit_json = || {
        if let Some(ref d) = decision {
            println!("{{\"decision\":\"{d}\"}}");
        } else if print_json {
            println!("{{}}");
        }
    };

    let session_id = session_override
        .or_else(|| std::env::var("RIFT_SESSION_ID").ok())
        .unwrap_or_default();
    if session_id.is_empty() {
        emit_json();
        return;
    }

    let ws_url = normalize_ws_url(&cfg.relay, "/ws/agent");
    let mut state = normalize_state(&event).to_string();

    // Inspect hook stdin JSON for agent-specific nuances:
    // - agy `Stop`: `"fullyIdle": false` means background tasks are still running -> stay `"running"`.
    // - claude `Notification`: `"notification_type": "idle_prompt"` is just an idle reminder -> `"idle"`.
    if (state == "idle" || state == "waiting") && !std::io::stdin().is_terminal() {
        let mut stdin_buf = String::new();
        if std::io::stdin().read_to_string(&mut stdin_buf).is_ok() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdin_buf) {
                if state == "idle" && v.get("fullyIdle").and_then(|b| b.as_bool()) == Some(false) {
                    state = "running".to_string();
                } else if state == "waiting"
                    && v.get("notification_type").and_then(|s| s.as_str()) == Some("idle_prompt")
                {
                    state = "idle".to_string();
                }
            }
        }
    }
    let msg = ControlMessage::AgentState {
        session_id,
        agent,
        state,
        secret: if cfg.secret.is_empty() {
            None
        } else {
            Some(cfg.secret)
        },
    };

    if let Ok(payload) = serde_json::to_string(&msg) {
        let _ = tokio::time::timeout(Duration::from_millis(600), async move {
            if let Ok((mut ws, _)) = connect_async(&ws_url).await {
                let _ = ws.send(Message::Text(payload.into())).await;
                let _ = ws.close(None).await;
            }
        })
        .await;
    }

    emit_json();
}
