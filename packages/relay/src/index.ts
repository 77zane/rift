import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  ByteRingBuffer,
  FRAME_PTY_INPUT,
  FRAME_PTY_OUTPUT,
  FRAME_PTY_REPLAY,
  decodeBinaryFrame,
  encodeBinaryFrame,
  type ControlMessage,
  type HostGroup,
  type SessionInfo,
} from "@rift/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 7700);
const HOST = process.env.HOST ?? "0.0.0.0";
const AGENT_SECRET = process.env.AGENT_SECRET ?? "";
const WEB_TOKEN = process.env.WEB_TOKEN ?? "";
const WEB_DIST = process.env.WEB_DIST
  ? path.resolve(process.env.WEB_DIST)
  : path.resolve(__dirname, "../../web/dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

interface AgentSession {
  ws: WebSocket;
  info: SessionInfo;
  buffer: ByteRingBuffer;
  viewers: Set<WebClient>;
  alive: boolean;
}

interface WebClient {
  ws: WebSocket;
  authed: boolean;
  attachedSessionId: string | null;
  alive: boolean;
}

interface HostDaemon {
  ws: WebSocket;
  hostId: string;
  hostName: string;
  platform: string;
  alive: boolean;
}

const sessions = new Map<string, AgentSession>();
const hostDaemons = new Map<string, HostDaemon>();
const webClients = new Set<WebClient>();

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return new Uint8Array(data);
}

function sendJson(ws: WebSocket, msg: ControlMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function buildHostGroups(): HostGroup[] {
  const byHost = new Map<string, HostGroup>();
  for (const daemon of hostDaemons.values()) {
    byHost.set(daemon.hostId, {
      hostId: daemon.hostId,
      hostName: daemon.hostName,
      platform: daemon.platform,
      sessions: [],
    });
  }
  for (const sess of sessions.values()) {
    let group = byHost.get(sess.info.hostId);
    if (!group) {
      group = {
        hostId: sess.info.hostId,
        hostName: sess.info.hostName,
        platform: sess.info.platform,
        sessions: [],
      };
      byHost.set(sess.info.hostId, group);
    }
    group.sessions.push({ ...sess.info });
  }
  const result = Array.from(byHost.values());
  result.sort((a, b) => a.hostName.localeCompare(b.hostName));
  for (const g of result) {
    g.sessions.sort((a, b) => a.createdAt - b.createdAt);
  }
  return result;
}

function broadcastSessionList(): void {
  const msg: ControlMessage = {
    type: "web.list",
    hosts: buildHostGroups(),
  };
  const payload = JSON.stringify(msg);
  for (const client of webClients) {
    if (client.authed && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

function detachViewer(client: WebClient): void {
  if (!client.attachedSessionId) return;
  const prev = sessions.get(client.attachedSessionId);
  if (prev) {
    prev.viewers.delete(client);
  }
  client.attachedSessionId = null;
}

function applyAgentState(sessionId: string, agent: string, state: "running" | "tool" | "waiting" | "idle"): boolean {
  const sess = sessions.get(sessionId);
  if (!sess) return false;
  sess.info.agentName = agent;
  sess.info.agentState = state;
  sess.info.agentUpdatedAt = Date.now();
  sess.info.lastActiveAt = Date.now();
  broadcastSessionList();
  return true;
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (reqUrl.pathname === "/api/agent-state" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf-8");
      if (body.length > 8192) req.destroy();
    });
    req.on("end", () => {
      try {
        const data = JSON.parse(body) as {
          sessionId?: string;
          agent?: string;
          state?: "running" | "tool" | "waiting" | "idle";
          secret?: string;
        };
        if (AGENT_SECRET && data.secret !== AGENT_SECRET) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid secret" }));
          return;
        }
        if (!data.sessionId || !data.agent || !data.state) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Missing fields" }));
          return;
        }
        const ok = applyAgentState(data.sessionId, data.agent, data.state);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
      }
    });
    return;
  }

  if (reqUrl.pathname === "/health") {
    const hosts = buildHostGroups();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        hosts: hosts.length,
        sessions: sessions.size,
        viewers: webClients.size,
        authRequired: Boolean(WEB_TOKEN),
      })
    );
    return;
  }

  let relPath = decodeURIComponent(reqUrl.pathname);
  if (relPath === "/") relPath = "/index.html";
  const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(WEB_DIST, safePath);

  if (!filePath.startsWith(WEB_DIST)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(WEB_DIST, "index.html");
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Web UI not built yet. Run `npm run build` first.");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(serveStatic);
const agentWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
const webWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (reqUrl.pathname === "/ws/agent") {
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      agentWss.emit("connection", ws, req);
    });
  } else if (reqUrl.pathname === "/ws/web") {
    webWss.handleUpgrade(req, socket, head, (ws) => {
      webWss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

agentWss.on("connection", (ws) => {
  let boundSessionId: string | null = null;
  let boundDaemonHostId: string | null = null;
  let alive = true;

  ws.on("pong", () => {
    alive = true;
    if (boundSessionId) {
      const s = sessions.get(boundSessionId);
      if (s) s.alive = true;
    }
    if (boundDaemonHostId) {
      const d = hostDaemons.get(boundDaemonHostId);
      if (d) d.alive = true;
    }
  });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      const frame = decodeBinaryFrame(toUint8Array(raw));
      if (!frame || !boundSessionId || frame.sessionId !== boundSessionId) return;
      const sess = sessions.get(boundSessionId);
      if (!sess) return;

      sess.info.lastActiveAt = Date.now();
      if (frame.frameType === FRAME_PTY_REPLAY) {
        sess.buffer.replace(frame.payload);
        // Forward replay only if viewers are waiting; usually initial reconnect restore.
        return;
      }
      if (frame.frameType === FRAME_PTY_OUTPUT) {
        sess.buffer.push(frame.payload);
        const out = encodeBinaryFrame(FRAME_PTY_OUTPUT, boundSessionId, frame.payload);
        for (const viewer of sess.viewers) {
          if (viewer.ws.readyState === WebSocket.OPEN) {
            viewer.ws.send(out);
          }
        }
      }
      return;
    }

    let msg: ControlMessage;
    try {
      msg = JSON.parse(raw.toString("utf-8")) as ControlMessage;
    } catch {
      return;
    }

    if (msg.type === "host.online") {
      if (AGENT_SECRET && msg.secret !== AGENT_SECRET) {
        sendJson(ws, { type: "error", message: "Invalid agent secret" });
        ws.close(4001, "Invalid secret");
        return;
      }
      const prev = hostDaemons.get(msg.hostId);
      if (prev && prev.ws !== ws) {
        prev.ws.close(4002, "Replaced by reconnecting host daemon");
      }
      boundDaemonHostId = msg.hostId;
      hostDaemons.set(msg.hostId, {
        ws,
        hostId: msg.hostId,
        hostName: msg.hostName,
        platform: msg.platform,
        alive,
      });
      broadcastSessionList();
      return;
    }

    if (msg.type === "agent.register") {
      if (AGENT_SECRET && msg.secret !== AGENT_SECRET) {
        sendJson(ws, { type: "error", message: "Invalid agent secret" });
        ws.close(4001, "Invalid secret");
        return;
      }

      const existing = sessions.get(msg.sessionId);
      const viewers = existing ? existing.viewers : new Set<WebClient>();
      const buffer = existing ? existing.buffer : new ByteRingBuffer(256 * 1024);
      if (existing && existing.ws !== ws) {
        existing.ws.close(4002, "Replaced by reconnecting agent");
      }

      const now = Date.now();
      boundSessionId = msg.sessionId;
      sessions.set(msg.sessionId, {
        ws,
        info: {
          sessionId: msg.sessionId,
          hostId: msg.hostId,
          hostName: msg.hostName,
          platform: msg.platform,
          title: msg.title,
          shell: msg.shell,
          cwd: msg.cwd,
          cols: msg.cols,
          rows: msg.rows,
          createdAt: existing ? existing.info.createdAt : now,
          lastActiveAt: now,
        },
        buffer,
        viewers,
        alive,
      });

      broadcastSessionList();
      return;
    }

    if (msg.type === "agent.update" && boundSessionId) {
      const sess = sessions.get(boundSessionId);
      if (!sess) return;
      let changed = false;
      if (msg.title !== undefined && msg.title !== sess.info.title) {
        sess.info.title = msg.title;
        changed = true;
      }
      if (msg.cwd !== undefined && msg.cwd !== sess.info.cwd) {
        sess.info.cwd = msg.cwd;
        changed = true;
      }
      if (msg.cols !== undefined && msg.cols !== sess.info.cols) {
        sess.info.cols = msg.cols;
        changed = true;
      }
      if (msg.rows !== undefined && msg.rows !== sess.info.rows) {
        sess.info.rows = msg.rows;
        changed = true;
      }
      if (changed) {
        broadcastSessionList();
      }
      return;
    }

    if (msg.type === "agent.state") {
      if (AGENT_SECRET && msg.secret !== AGENT_SECRET) {
        sendJson(ws, { type: "error", message: "Invalid agent secret" });
        ws.close(4001, "Invalid secret");
        return;
      }
      applyAgentState(msg.sessionId, msg.agent, msg.state);
      return;
    }

    if (msg.type === "agent.heartbeat" && boundSessionId) {
      const sess = sessions.get(boundSessionId);
      if (sess) sess.alive = true;
    }
  });

  ws.on("close", () => {
    let changed = false;
    if (boundDaemonHostId) {
      const d = hostDaemons.get(boundDaemonHostId);
      if (d && d.ws === ws) {
        hostDaemons.delete(boundDaemonHostId);
        changed = true;
      }
    }
    if (boundSessionId) {
      const sess = sessions.get(boundSessionId);
      if (sess && sess.ws === ws) {
        sessions.delete(boundSessionId);
        for (const viewer of sess.viewers) {
          if (viewer.attachedSessionId === boundSessionId) {
            viewer.attachedSessionId = null;
          }
        }
        changed = true;
      }
    }
    if (changed) broadcastSessionList();
  });
});

webWss.on("connection", (ws) => {
  const client: WebClient = {
    ws,
    authed: !WEB_TOKEN,
    attachedSessionId: null,
    alive: true,
  };
  webClients.add(client);

  if (client.authed) {
    sendJson(ws, { type: "web.auth_ok", authRequired: false });
    sendJson(ws, { type: "web.list", hosts: buildHostGroups() });
  }

  ws.on("pong", () => {
    client.alive = true;
  });

  ws.on("message", (raw, isBinary) => {
    if (!client.authed) {
      if (isBinary) return;
      let msg: ControlMessage;
      try {
        msg = JSON.parse(raw.toString("utf-8")) as ControlMessage;
      } catch {
        return;
      }
      if (msg.type === "web.auth") {
        if (msg.token === WEB_TOKEN) {
          client.authed = true;
          sendJson(ws, { type: "web.auth_ok", authRequired: true });
          sendJson(ws, { type: "web.list", hosts: buildHostGroups() });
        } else {
          sendJson(ws, { type: "web.auth_err", message: "Token 不正确" });
        }
      }
      return;
    }

    if (isBinary) {
      const frame = decodeBinaryFrame(toUint8Array(raw));
      if (!frame || frame.frameType !== FRAME_PTY_INPUT) return;
      const sess = sessions.get(frame.sessionId);
      if (!sess || sess.ws.readyState !== WebSocket.OPEN) return;
      sess.info.lastActiveAt = Date.now();
      sess.ws.send(encodeBinaryFrame(FRAME_PTY_INPUT, frame.sessionId, frame.payload));
      return;
    }

    let msg: ControlMessage;
    try {
      msg = JSON.parse(raw.toString("utf-8")) as ControlMessage;
    } catch {
      return;
    }

    if (msg.type === "web.attach") {
      detachViewer(client);
      const sess = sessions.get(msg.sessionId);
      if (!sess) {
        sendJson(ws, { type: "error", message: `会话不存在: ${msg.sessionId}` });
        return;
      }
      client.attachedSessionId = msg.sessionId;
      sess.viewers.add(client);
      const snap = sess.buffer.snapshot();
      if (snap.length > 0 && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeBinaryFrame(FRAME_PTY_REPLAY, msg.sessionId, snap));
      }
      return;
    }

    if (msg.type === "web.detach") {
      detachViewer(client);
      return;
    }

    if (msg.type === "term.resize") {
      const sess = sessions.get(msg.sessionId);
      if (!sess) return;
      if (msg.cols >= 20 && msg.cols <= 500 && msg.rows >= 5 && msg.rows <= 200) {
        sendJson(sess.ws, msg);
      }
      return;
    }

    if (msg.type === "host.spawn") {
      // Prefer host daemon if online, otherwise fall back to any online session agent on that host
      const daemon = hostDaemons.get(msg.hostId);
      if (daemon && daemon.ws.readyState === WebSocket.OPEN) {
        sendJson(daemon.ws, msg);
        return;
      }
      for (const sess of sessions.values()) {
        if (sess.info.hostId === msg.hostId && sess.ws.readyState === WebSocket.OPEN) {
          sendJson(sess.ws, msg);
          return;
        }
      }
      sendJson(ws, { type: "error", message: `主机不在线: ${msg.hostId}` });
      return;
    }

    if (msg.type === "term.close") {
      const sess = sessions.get(msg.sessionId);
      if (!sess) return;
      sendJson(sess.ws, msg);
    }
  });

  ws.on("close", () => {
    detachViewer(client);
    webClients.delete(client);
  });
});

// Heartbeat sweep every 25s
const heartbeatTimer = setInterval(() => {
  for (const [id, daemon] of hostDaemons) {
    if (!daemon.alive) {
      daemon.ws.terminate();
      hostDaemons.delete(id);
      continue;
    }
    daemon.alive = false;
    if (daemon.ws.readyState === WebSocket.OPEN) {
      daemon.ws.ping();
    }
  }
  for (const [id, sess] of sessions) {
    if (!sess.alive) {
      sess.ws.terminate();
      sessions.delete(id);
      continue;
    }
    sess.alive = false;
    if (sess.ws.readyState === WebSocket.OPEN) {
      sess.ws.ping();
    }
  }
  for (const client of webClients) {
    if (!client.alive) {
      client.ws.terminate();
      detachViewer(client);
      webClients.delete(client);
      continue;
    }
    client.alive = false;
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.ping();
    }
  }
}, 25_000);

heartbeatTimer.unref();

server.listen(PORT, HOST, () => {
  console.log(`[rift-relay] listening on http://${HOST}:${PORT}`);
  console.log(`[rift-relay] static web root: ${WEB_DIST}`);
  if (WEB_TOKEN) console.log("[rift-relay] WEB_TOKEN auth enabled");
  if (AGENT_SECRET) console.log("[rift-relay] AGENT_SECRET auth enabled");
});
