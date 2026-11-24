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

/// Refines reported hook state from optional agent stdin JSON:
/// - agy `Stop`: `"fullyIdle": false` means background tasks are still running -> stay `"running"`.
/// - claude `Notification`: `"notification_type": "idle_prompt"` is an idle reminder -> `"idle"`.
fn refine_state_from_stdin(initial_state: &str, stdin_json: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdin_json) {
        if initial_state == "idle" && v.get("fullyIdle").and_then(|b| b.as_bool()) == Some(false) {
            return "running".to_string();
        }
        if initial_state == "waiting"
            && v.get("notification_type").and_then(|s| s.as_str()) == Some("idle_prompt")
        {
            return "idle".to_string();
        }
    }
    initial_state.to_string()
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

    if (state == "idle" || state == "waiting") && !std::io::stdin().is_terminal() {
        let mut stdin_buf = String::new();
        if std::io::stdin().read_to_string(&mut stdin_buf).is_ok() {
            state = refine_state_from_stdin(&state, &stdin_buf);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_state_maps_known_events() {
        assert_eq!(normalize_state("running"), "running");
        assert_eq!(normalize_state("Pre_Tool_Use"), "tool");
        assert_eq!(normalize_state("notification"), "waiting");
        assert_eq!(normalize_state("Stop"), "idle");
        assert_eq!(normalize_state("unknown"), "running");
    }

    #[test]
    fn bugtdd_3_claude_idle_prompt_maps_to_idle_not_waiting() {
        assert_eq!(
            refine_state_from_stdin("waiting", r#"{"notification_type":"idle_prompt"}"#),
            "idle"
        );
        assert_eq!(
            refine_state_from_stdin("waiting", r#"{"notification_type":"permission_prompt"}"#),
            "waiting"
        );
    }

    #[test]
    fn agy_stop_with_fully_idle_false_stays_running() {
        assert_eq!(
            refine_state_from_stdin("idle", r#"{"fullyIdle":false}"#),
            "running"
        );
        assert_eq!(
            refine_state_from_stdin("idle", r#"{"fullyIdle":true}"#),
            "idle"
        );
        assert_eq!(refine_state_from_stdin("idle", "not-json"), "idle");
    }
}
