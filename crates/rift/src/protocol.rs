use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const FRAME_PTY_OUTPUT: u8 = 0x01;
pub const FRAME_PTY_INPUT: u8 = 0x02;
pub const FRAME_PTY_REPLAY: u8 = 0x03;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub host_id: String,
    pub host_name: String,
    pub platform: String,
    pub title: String,
    pub shell: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub created_at: u64,
    pub last_active_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGroup {
    pub host_id: String,
    pub host_name: String,
    pub platform: String,
    pub sessions: Vec<SessionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ControlMessage {
    #[serde(rename = "host.online", rename_all = "camelCase")]
    HostOnline {
        host_id: String,
        host_name: String,
        platform: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        secret: Option<String>,
    },
    #[serde(rename = "agent.register", rename_all = "camelCase")]
    AgentRegister {
        host_id: String,
        host_name: String,
        platform: String,
        session_id: String,
        title: String,
        shell: String,
        cwd: String,
        cols: u16,
        rows: u16,
        #[serde(skip_serializing_if = "Option::is_none")]
        secret: Option<String>,
    },
    #[serde(rename = "agent.update", rename_all = "camelCase")]
    AgentUpdate {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cols: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        rows: Option<u16>,
    },
    #[serde(rename = "agent.heartbeat", rename_all = "camelCase")]
    AgentHeartbeat { session_id: String },
    #[serde(rename = "agent.state", rename_all = "camelCase")]
    AgentState {
        session_id: String,
        agent: String,
        state: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        secret: Option<String>,
    },
    #[serde(rename = "web.auth", rename_all = "camelCase")]
    WebAuth {
        #[serde(skip_serializing_if = "Option::is_none")]
        token: Option<String>,
    },
    #[serde(rename = "web.auth_ok", rename_all = "camelCase")]
    WebAuthOk { auth_required: bool },
    #[serde(rename = "web.auth_err", rename_all = "camelCase")]
    WebAuthErr { message: String },
    #[serde(rename = "web.list", rename_all = "camelCase")]
    WebList { hosts: Vec<HostGroup> },
    #[serde(rename = "web.attach", rename_all = "camelCase")]
    WebAttach { session_id: String },
    #[serde(rename = "web.detach", rename_all = "camelCase")]
    WebDetach { session_id: String },
    #[serde(rename = "term.resize", rename_all = "camelCase")]
    TermResize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "host.spawn", rename_all = "camelCase")]
    HostSpawn {
        host_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        shell: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    #[serde(rename = "term.close", rename_all = "camelCase")]
    TermClose { session_id: String },
    #[serde(rename = "error", rename_all = "camelCase")]
    Error { message: String },
}

pub fn encode_binary_frame(frame_type: u8, session_id: &str, payload: &[u8]) -> Vec<u8> {
    let id_bytes = session_id.as_bytes();
    let mut out = Vec::with_capacity(2 + id_bytes.len() + payload.len());
    out.push(frame_type);
    out.push(id_bytes.len() as u8);
    out.extend_from_slice(id_bytes);
    out.extend_from_slice(payload);
    out
}

pub fn decode_binary_frame(raw: &[u8]) -> Option<(u8, String, &[u8])> {
    if raw.len() < 2 {
        return None;
    }
    let frame_type = raw[0];
    let id_len = raw[1] as usize;
    if raw.len() < 2 + id_len {
        return None;
    }
    let session_id = std::str::from_utf8(&raw[2..2 + id_len]).ok()?.to_string();
    Some((frame_type, session_id, &raw[2 + id_len..]))
}

pub struct ByteRingBuffer {
    chunks: VecDeque<Vec<u8>>,
    total: usize,
    max_bytes: usize,
}

impl ByteRingBuffer {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            total: 0,
            max_bytes,
        }
    }

    pub fn push(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        self.chunks.push_back(data.to_vec());
        self.total += data.len();
        while self.total > self.max_bytes {
            if let Some(front) = self.chunks.pop_front() {
                self.total -= front.len();
            } else {
                break;
            }
        }
    }

    pub fn snapshot(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.total);
        for c in &self.chunks {
            out.extend_from_slice(c);
        }
        out
    }
}
