#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn as spawnChild, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import WebSocket, { type RawData } from "ws";
import {
  ByteRingBuffer,
  FRAME_PTY_INPUT,
  FRAME_PTY_OUTPUT,
  FRAME_PTY_REPLAY,
  decodeBinaryFrame,
  encodeBinaryFrame,
  type ControlMessage,
} from "@rift/shared";
import { runAttach } from "./attach.js";

if (process.argv[2] === "attach") {
  await runAttach(process.argv.slice(3));
  // Keep event loop alive until attach exits cleanly
  await new Promise(() => {});
}

const __filename = fileURLToPath(import.meta.url);

interface AgentOptions {
  relay: string;
  hostId: string;
  hostName: string;
  title?: string;
  secret: string;
  noLocal: boolean;
  cols?: number;
  rows?: number;
  command: string[];
}

function resolveDefaultShell(): string {
  if (process.platform === "win32") {
    for (const candidate of ["pwsh.exe", "powershell.exe", "cmd.exe"]) {
      try {
        execFileSync("where.exe", [candidate], { stdio: "ignore" });
        return candidate;
      } catch {
        // try next
      }
    }
    return process.env.COMSPEC || "cmd.exe";
  }
  return process.env.SHELL || "/bin/bash";
}

function parseArgs(argv: string[]): AgentOptions {
  const defaultHost = os.hostname();
  let relay = process.env.AGENTSHARE_RELAY ?? "ws://127.0.0.1:7700";
  let hostId = process.env.AGENTSHARE_HOST_ID ?? defaultHost;
  let hostName = process.env.AGENTSHARE_HOST ?? defaultHost;
  let title = process.env.AGENTSHARE_TITLE;
  let secret = process.env.AGENTSHARE_SECRET ?? "";
  let noLocal = false;
  let cols: number | undefined;
  let rows: number | undefined;
  let command: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      command = argv.slice(i + 1);
      break;
    }
    if (arg === "--relay" && argv[i + 1]) {
      relay = argv[++i];
    } else if (arg === "--host" && argv[i + 1]) {
      hostName = argv[++i];
      hostId = hostName;
    } else if (arg === "--host-id" && argv[i + 1]) {
      hostId = argv[++i];
    } else if (arg === "--title" && argv[i + 1]) {
      title = argv[++i];
    } else if (arg === "--secret" && argv[i + 1]) {
      secret = argv[++i];
    } else if (arg === "--cols" && argv[i + 1]) {
      cols = Number(argv[++i]);
    } else if (arg === "--rows" && argv[i + 1]) {
      rows = Number(argv[++i]);
    } else if (arg === "--no-local") {
      noLocal = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        [
          "Usage: agentshare [options] [-- <shell> [args...]]",
          "",
          "Options:",
          "  --relay <ws-url>   Relay server URL (default: ws://127.0.0.1:7700 or AGENTSHARE_RELAY)",
          "  --host <name>      Host display name & ID (default: hostname or AGENTSHARE_HOST)",
          "  --title <title>    Initial tab title",
          "  --secret <secret>  Shared agent secret (or AGENTSHARE_SECRET)",
          "  --no-local         Headless mode (do not bind local stdin/stdout)",
          "  --cols <n>         Initial columns (headless override)",
          "  --rows <n>         Initial rows (headless override)",
        ].join("\n")
      );
      process.exit(0);
    } else {
      command = argv.slice(i);
      break;
    }
  }

  if (command.length === 0) {
    command = [resolveDefaultShell()];
  }

  return { relay, hostId, hostName, title, secret, noLocal, cols, rows, command };
}

function normalizeRelayWsUrl(relay: string): string {
  const trimmed = relay.replace(/\/+$/, "");
  if (trimmed.endsWith("/ws/agent")) return trimmed;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice(7)}/ws/agent`;
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice(8)}/ws/agent`;
  return `${trimmed}/ws/agent`;
}

function extractOscTitle(chunk: string): string | null {
  // Match OSC 0 or OSC 2 terminated by BEL (\x07) or ST (\x1b\\)
  const regex = /\x1b\](?:0|2);([^\x07\x1b]{1,200})(?:\x07|\x1b\\)/g;
  let last: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(chunk)) !== null) {
    let t = match[1].trim();
    if (!t) continue;
    // Shorten raw Windows executable full paths (e.g. C:\Program Files\WindowsApps\...\pwsh.exe -> pwsh.exe)
    if (/^[A-Za-z]:\\.*\.exe$/i.test(t)) {
      t = path.basename(t);
    }
    last = t;
  }
  return last;
}

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return new Uint8Array(data);
}

const opts = parseArgs(process.argv.slice(2));
const sessionId = crypto.randomBytes(6).toString("hex");
const shellBin = opts.command[0];
const shellArgs = opts.command.slice(1);
const shellLabel = path.basename(shellBin);
const cwd = process.cwd();

let currentCols = opts.cols ?? (process.stdout.isTTY ? process.stdout.columns : 120) ?? 120;
let currentRows = opts.rows ?? (process.stdout.isTTY ? process.stdout.rows : 32) ?? 32;
let currentTitle = opts.title || shellLabel;

const ringBuffer = new ByteRingBuffer(256 * 1024);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Cleanly inherit the full host environment so tools like agy.exe / pwsh work identically to native WT.
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) env[k] = v;
}
env.AGENTSHARE_SESSION_ID = sessionId;
env.AGENTSHARE_HOST = opts.hostName;
if (!env.TERM) env.TERM = "xterm-256color";

const ptyProcess = pty.spawn(shellBin, shellArgs, {
  name: "xterm-256color",
  cols: currentCols,
  rows: currentRows,
  cwd,
  env,
});

let shuttingDown = false;
let ws: WebSocket | null = null;
let reconnectDelayMs = 1000;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

function sendControl(msg: ControlMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function spawnNewTabOnHost(reqShell?: string, reqCwd?: string): void {
  const targetCwd = reqCwd || cwd;
  const targetShell = reqShell || shellBin;
  const agentArgs = [
    __filename,
    "--relay",
    opts.relay,
    "--host",
    opts.hostName,
    "--host-id",
    opts.hostId,
    "--no-local",
  ];
  if (opts.secret) {
    agentArgs.push("--secret", opts.secret);
  }
  agentArgs.push("--", targetShell);

  const child = spawnChild(process.execPath, agentArgs, {
    cwd: targetCwd,
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
}

function connectRelay(): void {
  if (shuttingDown) return;
  const wsUrl = normalizeRelayWsUrl(opts.relay);
  const socket = new WebSocket(wsUrl);
  ws = socket;

  socket.on("open", () => {
    reconnectDelayMs = 1000;
    sendControl({
      type: "agent.register",
      hostId: opts.hostId,
      hostName: opts.hostName,
      platform: process.platform,
      sessionId,
      title: currentTitle,
      shell: shellLabel,
      cwd,
      cols: currentCols,
      rows: currentRows,
      secret: opts.secret || undefined,
    });

    const snap = ringBuffer.snapshot();
    if (snap.length > 0 && socket.readyState === WebSocket.OPEN) {
      socket.send(encodeBinaryFrame(FRAME_PTY_REPLAY, sessionId, snap));
    }

    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      sendControl({ type: "agent.heartbeat", sessionId });
    }, 15_000);
    heartbeatTimer.unref();
  });

  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      const frame = decodeBinaryFrame(toUint8Array(raw));
      if (!frame || frame.frameType !== FRAME_PTY_INPUT || frame.sessionId !== sessionId) return;
      const text = textDecoder.decode(frame.payload);
      ptyProcess.write(text);
      return;
    }

    let msg: ControlMessage;
    try {
      msg = JSON.parse(raw.toString("utf-8")) as ControlMessage;
    } catch {
      return;
    }

    if (msg.type === "term.resize" && msg.sessionId === sessionId) {
      if (msg.cols !== currentCols || msg.rows !== currentRows) {
        currentCols = msg.cols;
        currentRows = msg.rows;
        try {
          ptyProcess.resize(currentCols, currentRows);
        } catch {
          // ignore invalid resize
        }
        sendControl({
          type: "agent.update",
          sessionId,
          cols: currentCols,
          rows: currentRows,
        });
      }
      return;
    }

    if (msg.type === "host.spawn" && msg.hostId === opts.hostId) {
      spawnNewTabOnHost(msg.shell, msg.cwd);
      return;
    }

    if (msg.type === "term.close" && msg.sessionId === sessionId) {
      cleanupAndExit(0);
    }
  });

  const scheduleReconnect = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (ws === socket) ws = null;
    if (shuttingDown || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectRelay();
    }, reconnectDelayMs);
    reconnectTimer.unref();
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5000);
  };

  socket.on("close", scheduleReconnect);
  socket.on("error", () => {
    // Never disrupt local shell on relay network errors; reconnect silently.
    scheduleReconnect();
  });
}

// Forward PTY output to local stdout + ringBuffer + Relay
ptyProcess.onData((data) => {
  if (!opts.noLocal) {
    process.stdout.write(data);
  }

  const bytes = textEncoder.encode(data);
  ringBuffer.push(bytes);

  const nextTitle = extractOscTitle(data);
  if (nextTitle && nextTitle !== currentTitle) {
    currentTitle = nextTitle;
    sendControl({ type: "agent.update", sessionId, title: currentTitle });
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(encodeBinaryFrame(FRAME_PTY_OUTPUT, sessionId, bytes));
  }
});

// Bind local interactive terminal stdin/stdout in transparent raw mode
if (!opts.noLocal && process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer) => {
    ptyProcess.write(chunk.toString("utf-8"));
  });
}

if (!opts.noLocal && process.stdout.isTTY) {
  process.stdout.on("resize", () => {
    const cols = process.stdout.columns;
    const rows = process.stdout.rows;
    if (cols && rows && (cols !== currentCols || rows !== currentRows)) {
      currentCols = cols;
      currentRows = rows;
      try {
        ptyProcess.resize(currentCols, currentRows);
      } catch {
        // ignore
      }
      sendControl({ type: "agent.update", sessionId, cols: currentCols, rows: currentRows });
    }
  });
}

function cleanupAndExit(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (!opts.noLocal && process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch {
      // ignore
    }
  }
  try {
    ptyProcess.kill();
  } catch {
    // ignore
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(1000, "Session ended");
  }
  process.exit(code);
}

ptyProcess.onExit(({ exitCode }) => {
  cleanupAndExit(exitCode ?? 0);
});

process.on("SIGTERM", () => cleanupAndExit(0));

connectRelay();
