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
const SESSION_GRACE_MS = Math.max(0, Number(process.env.SESSION_GRACE_MS ?? 15_000));
const REMEMBERED_TITLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MISSED_PINGS = 2;
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
  missedPings: number;
  closing: boolean;
  disconnected: boolean;
  needsViewerResync: boolean;
  graceTimer: NodeJS.Timeout | null;
}

interface WebClient {
  ws: WebSocket;
  authed: boolean;
  attachedSessionId: string | null;
  missedPings: number;
}

interface HostDaemon {
  ws: WebSocket;
  hostId: string;
  hostName: string;
  platform: string;
  missedPings: number;
}

const sessions = new Map<string, AgentSession>();
const hostDaemons = new Map<string, HostDaemon>();
const webClients = new Set<WebClient>();
const rememberedTitles = new Map<string, { title: string; updatedAt: number }>();
const RELAY_BOOT_ID = Math.random().toString(36).slice(2, 10);

// Lightweight in-memory brute-force protection for WEB_TOKEN auth (5 fails -> 15 min lock per IP)
const MAX_AUTH_FAILS = 5;
const AUTH_LOCK_MS = 15 * 60 * 1000;
const authFailures = new Map<string, { count: number; lockedUntil: number }>();

function extractClientIp(req: http.IncomingMessage): string {
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) return realIp.trim();
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

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

function finalizeSessionClose(sessionId: string, clearRememberedTitle: boolean): void {
  const sess = sessions.get(sessionId);
  if (!sess) return;
  if (sess.graceTimer) {
    clearTimeout(sess.graceTimer);
    sess.graceTimer = null;
  }
  sessions.delete(sessionId);
  if (clearRememberedTitle) {
    rememberedTitles.delete(sessionId);
  }
  for (const viewer of sess.viewers) {
    if (viewer.attachedSessionId === sessionId) {
      viewer.attachedSessionId = null;
    }
  }
  sess.viewers.clear();
  broadcastSessionList();
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
const wsDeflate = {
  threshold: 1024,
  zlibDeflateOptions: { level: 3 },
};
const agentWss = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024 * 1024,
  perMessageDeflate: wsDeflate,
});
const webWss = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024 * 1024,
  perMessageDeflate: wsDeflate,
});

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

  const markAlive = () => {
    if (boundSessionId) {
      const s = sessions.get(boundSessionId);
      if (s && s.ws === ws) s.missedPings = 0;
    }
    if (boundDaemonHostId) {
      const d = hostDaemons.get(boundDaemonHostId);
      if (d && d.ws === ws) d.missedPings = 0;
    }
  };

  ws.on("pong", markAlive);
  ws.on("ping", markAlive);

  ws.on("message", (raw, isBinary) => {
    markAlive();

    if (isBinary) {
      const frame = decodeBinaryFrame(toUint8Array(raw));
      if (!frame || !boundSessionId || frame.sessionId !== boundSessionId) return;
      const sess = sessions.get(boundSessionId);
      if (!sess) return;

      sess.info.lastActiveAt = Date.now();
      if (frame.frameType === FRAME_PTY_REPLAY) {
        sess.buffer.replace(frame.payload);
        if (sess.needsViewerResync) {
          sess.needsViewerResync = false;
          const snap = sess.buffer.snapshot();
          const headSeq = sess.buffer.headOffset;
          for (const viewer of sess.viewers) {
            if (viewer.ws.readyState === WebSocket.OPEN) {
              if (snap.length > 0) {
                viewer.ws.send(encodeBinaryFrame(FRAME_PTY_REPLAY, boundSessionId, snap));
              }
              sendJson(viewer.ws, { type: "web.sync", sessionId: boundSessionId, seq: headSeq });
            }
          }
        }
        return;
      }
      if (frame.frameType === FRAME_PTY_OUTPUT) {
        sess.needsViewerResync = false;
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
        missedPings: 0,
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
      if (existing?.graceTimer) {
        clearTimeout(existing.graceTimer);
        existing.graceTimer = null;
      }
      const viewers = existing ? existing.viewers : new Set<WebClient>();
      const buffer = existing ? existing.buffer : new ByteRingBuffer(4 * 1024 * 1024);
      if (existing && existing.ws !== ws) {
        existing.ws.close(4002, "Replaced by reconnecting agent");
      }

      const now = Date.now();
      const remembered = rememberedTitles.get(msg.sessionId);
      let title = msg.title;
      let customTitle = false;
      if (existing?.info.customTitle) {
        title = existing.info.title;
        customTitle = true;
      } else if (msg.customTitle && msg.title.trim()) {
        title = msg.title.trim().slice(0, 64);
        customTitle = true;
        rememberedTitles.set(msg.sessionId, { title, updatedAt: now });
      } else if (remembered) {
        title = remembered.title;
        customTitle = true;
        remembered.updatedAt = now;
      }

      boundSessionId = msg.sessionId;
      sessions.set(msg.sessionId, {
        ws,
        info: {
          sessionId: msg.sessionId,
          hostId: msg.hostId,
          hostName: msg.hostName,
          platform: msg.platform,
          title,
          shell: msg.shell,
          cwd: msg.cwd,
          cols: msg.cols,
          rows: msg.rows,
          headless: Boolean(msg.headless),
          customTitle,
          reconnecting: false,
          agentName: existing?.info.agentName,
          agentState: existing?.info.agentState,
          agentUpdatedAt: existing?.info.agentUpdatedAt,
          createdAt: existing ? existing.info.createdAt : now,
          lastActiveAt: now,
        },
        buffer,
        viewers,
        missedPings: 0,
        closing: false,
        disconnected: false,
        needsViewerResync: Boolean(existing && viewers.size > 0),
        graceTimer: null,
      });

      // Push authoritative custom title down to agent if agent did not already have it
      if (customTitle && !msg.customTitle) {
        sendJson(ws, { type: "term.rename", sessionId: msg.sessionId, title });
      }

      broadcastSessionList();
      return;
    }

    if (msg.type === "agent.update" && boundSessionId) {
      const sess = sessions.get(boundSessionId);
      if (!sess) return;
      let changed = false;
      if (msg.title !== undefined && !sess.info.customTitle && msg.title !== sess.info.title) {
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
      if (sess && sess.ws === ws) sess.missedPings = 0;
    }
  });

  ws.on("close", (code) => {
    let changed = false;
    if (boundDaemonHostId) {
      const d = hostDaemons.get(boundDaemonHostId);
      if (d && d.ws === ws) {
        hostDaemons.delete(boundDaemonHostId);
        changed = true;
      }
    }
    if (boundSessionId) {
      const sid = boundSessionId;
      const sess = sessions.get(sid);
      if (sess && sess.ws === ws) {
        const cleanClose = sess.closing || code === 1000;
        if (cleanClose || SESSION_GRACE_MS <= 0) {
          finalizeSessionClose(sid, true);
          changed = false; // finalizeSessionClose already broadcasts
        } else {
          // Unexpected disconnect (Wi-Fi roam, sleep/wake, network blip): keep session alive
          // during grace period so viewers aren't kicked out and custom titles aren't wiped.
          sess.disconnected = true;
          sess.info.reconnecting = true;
          if (sess.graceTimer) clearTimeout(sess.graceTimer);
          sess.graceTimer = setTimeout(() => {
            const cur = sessions.get(sid);
            if (cur && cur.ws === ws && cur.disconnected) {
              finalizeSessionClose(sid, false);
            }
          }, SESSION_GRACE_MS);
          sess.graceTimer.unref();
          changed = true;
        }
      }
    }
    if (changed) broadcastSessionList();
  });
});

webWss.on("connection", (ws, req) => {
  const clientIp = extractClientIp(req);
  const client: WebClient = {
    ws,
    authed: !WEB_TOKEN,
    attachedSessionId: null,
    missedPings: 0,
  };
  webClients.add(client);

  if (client.authed) {
    sendJson(ws, { type: "web.auth_ok", authRequired: false, bootId: RELAY_BOOT_ID });
    sendJson(ws, { type: "web.list", hosts: buildHostGroups() });
  }

  ws.on("pong", () => {
    client.missedPings = 0;
  });
  ws.on("ping", () => {
    client.missedPings = 0;
  });

  ws.on("message", (raw, isBinary) => {
    client.missedPings = 0;
    if (!client.authed) {
      if (isBinary) return;
      let msg: ControlMessage;
      try {
        msg = JSON.parse(raw.toString("utf-8")) as ControlMessage;
      } catch {
        return;
      }
      if (msg.type === "web.auth") {
        const now = Date.now();
        const rec = authFailures.get(clientIp);
        if (rec && rec.lockedUntil > now) {
          const mins = Math.ceil((rec.lockedUntil - now) / 60000);
          sendJson(ws, {
            type: "web.auth_err",
            message: `尝试次数过多，请 ${mins} 分钟后再试`,
          });
          return;
        }
        if (msg.token === WEB_TOKEN) {
          authFailures.delete(clientIp);
          client.authed = true;
          sendJson(ws, { type: "web.auth_ok", authRequired: true, bootId: RELAY_BOOT_ID });
          sendJson(ws, { type: "web.list", hosts: buildHostGroups() });
        } else {
          const nextCount = (rec ? rec.count : 0) + 1;
          const lockedUntil = nextCount >= MAX_AUTH_FAILS ? now + AUTH_LOCK_MS : 0;
          authFailures.set(clientIp, { count: nextCount, lockedUntil });
          const remain = MAX_AUTH_FAILS - nextCount;
          sendJson(ws, {
            type: "web.auth_err",
            message:
              remain > 0
                ? `Token 不正确（剩余 ${remain} 次机会）`
                : "尝试次数过多，已锁定 15 分钟",
          });
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
      const headSeq = sess.buffer.headOffset;
      if (typeof msg.sinceSeq === "number") {
        const delta = sess.buffer.sliceSince(msg.sinceSeq);
        if (delta !== null) {
          if (delta.length > 0 && ws.readyState === WebSocket.OPEN) {
            ws.send(encodeBinaryFrame(FRAME_PTY_OUTPUT, msg.sessionId, delta));
          }
          sendJson(ws, { type: "web.sync", sessionId: msg.sessionId, seq: headSeq });
          return;
        }
      }
      const snap = sess.buffer.snapshot();
      if (snap.length > 0 && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeBinaryFrame(FRAME_PTY_REPLAY, msg.sessionId, snap));
      }
      sendJson(ws, { type: "web.sync", sessionId: msg.sessionId, seq: headSeq });
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
      sess.closing = true;
      if (sess.disconnected || sess.ws.readyState !== WebSocket.OPEN) {
        finalizeSessionClose(msg.sessionId, true);
      } else {
        sendJson(sess.ws, msg);
      }
      return;
    }

    if (msg.type === "term.rename") {
      const sess = sessions.get(msg.sessionId);
      if (!sess) return;
      const next = msg.title.trim().slice(0, 64);
      if (!next) return;
      sess.info.title = next;
      sess.info.customTitle = true;
      rememberedTitles.set(msg.sessionId, { title: next, updatedAt: Date.now() });
      // Sync custom title to agent so it survives network drops AND relay restarts
      if (sess.ws.readyState === WebSocket.OPEN) {
        sendJson(sess.ws, { type: "term.rename", sessionId: msg.sessionId, title: next });
      }
      broadcastSessionList();
      return;
    }

    if (msg.type === "term.paste_image") {
      const sess = sessions.get(msg.sessionId);
      if (!sess || sess.ws.readyState !== WebSocket.OPEN) return;
      // Forward base64 image payload to target host agent (capped by webWss 16MB maxPayload)
      sendJson(sess.ws, msg);
    }
  });

  ws.on("close", () => {
    detachViewer(client);
    webClients.delete(client);
  });
});

// Heartbeat sweep every 25s (allow MAX_MISSED_PINGS=2 -> 50s tolerance before terminating)
const heartbeatTimer = setInterval(() => {
  let daemonChanged = false;
  for (const [id, daemon] of hostDaemons) {
    if (daemon.ws.readyState === WebSocket.CLOSED) {
      hostDaemons.delete(id);
      daemonChanged = true;
      continue;
    }
    if (daemon.missedPings >= MAX_MISSED_PINGS) {
      daemon.ws.terminate();
      continue;
    }
    daemon.missedPings += 1;
    if (daemon.ws.readyState === WebSocket.OPEN) {
      daemon.ws.ping();
    }
  }
  if (daemonChanged) broadcastSessionList();

  for (const [, sess] of sessions) {
    if (sess.disconnected) continue;
    if (sess.missedPings >= MAX_MISSED_PINGS) {
      // Let the close handler apply the grace period & viewer cleanup uniformly
      sess.ws.terminate();
      continue;
    }
    sess.missedPings += 1;
    if (sess.ws.readyState === WebSocket.OPEN) {
      sess.ws.ping();
    }
  }

  for (const client of webClients) {
    if (client.missedPings >= MAX_MISSED_PINGS) {
      client.ws.terminate();
      detachViewer(client);
      webClients.delete(client);
      continue;
    }
    client.missedPings += 1;
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.ping();
    }
  }

  // Prune stale remembered custom titles
  const now = Date.now();
  for (const [sid, rec] of rememberedTitles) {
    if (!sessions.has(sid) && now - rec.updatedAt > REMEMBERED_TITLE_TTL_MS) {
      rememberedTitles.delete(sid);
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
