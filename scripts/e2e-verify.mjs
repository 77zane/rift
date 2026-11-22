import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  FRAME_PTY_INPUT,
  FRAME_PTY_OUTPUT,
  FRAME_PTY_REPLAY,
  decodeBinaryFrame,
  encodeBinaryFrame,
} from "../packages/shared/dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const relayEntry = path.join(rootDir, "packages/relay/dist/index.js");
const riftExe = path.join(
  rootDir,
  "crates/rift/target/release",
  process.platform === "win32" ? "rift.exe" : "rift"
);

const PORT = 17700;
const BASE_HTTP = `http://127.0.0.1:${PORT}`;
const BASE_WS = `ws://127.0.0.1:${PORT}`;

const children = new Set();

function spawnProc(bin, args, extraEnv = {}) {
  const child = spawn(bin, args, {
    cwd: rootDir,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function killChild(child) {
  if (!child) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
}

function cleanup() {
  for (const c of children) killChild(c);
}

async function waitForHealth(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_HTTP}/health`);
      if (res.ok) return await res.json();
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Relay failed to start within timeout");
}

function createWebViewer(token = "") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE_WS}/ws/web`);
    ws.binaryType = "arraybuffer";
    const state = {
      ws,
      hosts: [],
      replayCountBySession: new Map(),
      outputBySession: new Map(),
      replayBySession: new Map(),
      authOk: false,
      authErr: null,
      listeners: [],
    };
    const notify = () => {
      for (const fn of [...state.listeners]) fn();
    };
    ws.on("open", () => {
      if (token) {
        ws.send(JSON.stringify({ type: "web.auth", token }));
      }
      resolve(state);
    });
    ws.on("error", reject);
    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        const buf = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw);
        const frame = decodeBinaryFrame(buf);
        if (!frame) return;
        const text = new TextDecoder().decode(frame.payload);
        if (frame.frameType === FRAME_PTY_REPLAY) {
          state.replayCountBySession.set(
            frame.sessionId,
            (state.replayCountBySession.get(frame.sessionId) ?? 0) + 1
          );
          state.replayBySession.set(
            frame.sessionId,
            (state.replayBySession.get(frame.sessionId) ?? "") + text
          );
        } else if (frame.frameType === FRAME_PTY_OUTPUT) {
          state.outputBySession.set(
            frame.sessionId,
            (state.outputBySession.get(frame.sessionId) ?? "") + text
          );
        }
        notify();
        return;
      }
      const msg = JSON.parse(raw.toString("utf-8"));
      if (msg.type === "web.auth_ok") {
        state.authOk = true;
        notify();
      } else if (msg.type === "web.auth_err") {
        state.authErr = msg.message;
        notify();
      } else if (msg.type === "web.list") {
        state.hosts = msg.hosts;
        notify();
      }
    });
  });
}

function waitUntil(viewer, predicate, label, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (predicate()) return resolve();
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for: ${label}`));
    }, timeoutMs);
    const check = () => {
      if (predicate()) {
        clearTimeout(timer);
        const idx = viewer.listeners.indexOf(check);
        if (idx >= 0) viewer.listeners.splice(idx, 1);
        resolve();
      }
    };
    viewer.listeners.push(check);
  });
}

async function main() {
  console.log("1. Starting Rift relay...");
  let relay = spawnProc(process.execPath, [relayEntry], { PORT: String(PORT), HOST: "127.0.0.1" });
  relay.stderr.on("data", (d) => process.stderr.write(`[relay err] ${d}`));

  const health = await waitForHealth();
  assert.equal(health.ok, true);

  const indexRes = await fetch(`${BASE_HTTP}/`);
  assert.equal(indexRes.status, 200);
  const indexHtml = await indexRes.text();
  assert.ok(indexHtml.includes("Rift") && indexHtml.includes("ember"), "Web UI should be Rift EMBER/PHOSPHOR");
  console.log("   OK: /health and Rift web UI verified.");

  console.log("2. Starting Rust rift.exe (Win-A1 session + Win-Daemon 0-session keeper)...");
  const agent1 = spawnProc(riftExe, [
    "--relay",
    BASE_WS,
    "--host",
    "Win-A1",
    "--title",
    "PowerShell-Main",
    "--cols",
    "120",
    "--rows",
    "32",
    "--no-local",
  ]);
  const daemon1 = spawnProc(riftExe, ["--relay", BASE_WS, "--host", "Win-Daemon", "daemon"]);
  agent1.stderr.on("data", (d) => process.stderr.write(`[rift1 err] ${d}`));
  daemon1.stderr.on("data", (d) => process.stderr.write(`[daemon err] ${d}`));

  const viewer1 = await createWebViewer();
  await waitUntil(viewer1, () => viewer1.hosts.length === 2, "both Win-A1 and Win-Daemon online");
  const hostA1 = viewer1.hosts.find((h) => h.hostName === "Win-A1");
  const hostDaemon = viewer1.hosts.find((h) => h.hostName === "Win-Daemon");
  assert.equal(hostA1.sessions[0].cols, 120);
  assert.equal(hostA1.sessions[0].rows, 32);
  assert.equal(hostDaemon.sessions.length, 0, "Daemon host starts online with 0 sessions");
  const sid1 = hostA1.sessions[0].sessionId;
  console.log(`   OK: Rust rift.exe Win-A1=${sid1} (120x32) & Win-Daemon (0 sessions) online.`);

  console.log("3. Testing real shell execution inside Rust PTY...");
  viewer1.ws.send(JSON.stringify({ type: "web.attach", sessionId: sid1 }));
  const cmd1 =
    process.platform === "win32"
      ? 'Write-Output "RIFT_RUST_OK_777"\r'
      : 'echo "RIFT_RUST_OK_777"\r';
  viewer1.ws.send(encodeBinaryFrame(FRAME_PTY_INPUT, sid1, new TextEncoder().encode(cmd1)));
  await waitUntil(
    viewer1,
    () => (viewer1.outputBySession.get(sid1) ?? "").includes("RIFT_RUST_OK_777"),
    "PTY output contains RIFT_RUST_OK_777"
  );
  console.log("   OK: bidirectional shell I/O ran cleanly inside Rust PTY.");

  console.log("4. Testing Ring Buffer replay on fresh viewer...");
  const viewer2 = await createWebViewer();
  await waitUntil(viewer2, () => viewer2.hosts.length === 2, "viewer2 gets host list");
  viewer2.ws.send(JSON.stringify({ type: "web.attach", sessionId: sid1 }));
  await waitUntil(
    viewer2,
    () => (viewer2.replayBySession.get(sid1) ?? "").includes("RIFT_RUST_OK_777"),
    "viewer2 receives Ring Buffer replay"
  );
  console.log("   OK: Ring Buffer instant replay verified.");

  console.log("5. Testing remote `+` spawn on 0-session Win-Daemon & term.close...");
  viewer1.ws.send(JSON.stringify({ type: "host.spawn", hostId: hostDaemon.hostId }));
  await waitUntil(
    viewer1,
    () => {
      const h = viewer1.hosts.find((x) => x.hostName === "Win-Daemon");
      return h && h.sessions.length === 1;
    },
    "Win-Daemon spawns 1st session on remote +"
  );
  const spawnedSid = viewer1.hosts.find((x) => x.hostName === "Win-Daemon").sessions[0].sessionId;
  viewer1.ws.send(JSON.stringify({ type: "term.close", sessionId: spawnedSid }));
  await waitUntil(
    viewer1,
    () => {
      const h = viewer1.hosts.find((x) => x.hostName === "Win-Daemon");
      return h && h.sessions.length === 0;
    },
    "term.close returns Win-Daemon to 0 sessions while staying online"
  );
  console.log("   OK: 0-session daemon spawn & close verified.");

  console.log("6. Testing rift.exe agent-hook active AI state reporting (running -> tool -> idle)...");
  for (const [ev, expected] of [
    ["running", "running"],
    ["tool", "tool"],
    ["idle", "idle"],
  ]) {
    const hookProc = spawnProc(riftExe, [
      "--relay",
      BASE_WS,
      "agent-hook",
      "--agent",
      "agy",
      "--event",
      ev,
      "--session-id",
      sid1,
    ]);
    await new Promise((res) => hookProc.on("exit", res));
    await waitUntil(
      viewer1,
      () => {
        const h = viewer1.hosts.find((x) => x.hostName === "Win-A1");
        return h && h.sessions[0].agentName === "agy" && h.sessions[0].agentState === expected;
      },
      `agentState updated to ${expected}`
    );
  }
  console.log("   OK: active AI agent state reporting (running -> tool -> idle) verified.");

  console.log("7. Testing Rust auto-reconnect & Ring Buffer restore after Relay restart...");
  viewer1.ws.close();
  viewer2.ws.close();
  killChild(relay);
  await new Promise((r) => setTimeout(r, 500));
  relay = spawnProc(process.execPath, [relayEntry], { PORT: String(PORT), HOST: "127.0.0.1" });
  await waitForHealth();
  const viewer3 = await createWebViewer();
  await waitUntil(viewer3, () => viewer3.hosts.length === 2, "both Rust clients auto-reconnected");
  viewer3.ws.send(JSON.stringify({ type: "web.attach", sessionId: sid1 }));
  await waitUntil(
    viewer3,
    () => (viewer3.replayBySession.get(sid1) ?? "").includes("RIFT_RUST_OK_777"),
    "Rust client restored Ring Buffer after relay restart"
  );
  viewer3.ws.close();
  console.log("   OK: Rust auto-reconnect & Ring Buffer restore verified.");

  console.log("\nALL RUST RIFT E2E CHECKS PASSED!");
}

try {
  await main();
  cleanup();
  process.exit(0);
} catch (err) {
  console.error("E2E FAILED:", err);
  cleanup();
  process.exit(1);
}
