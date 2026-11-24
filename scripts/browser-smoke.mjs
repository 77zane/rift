#!/usr/bin/env node
/**
 * Real headless browser smoke test (zero Playwright dependency — uses local Chrome/Edge + CDP).
 *
 * Regression gates:
 *   1. Production Vite bundle (`packages/web/dist/`) loads with 0 JS exceptions / console errors.
 *   2. Real `@xterm/xterm@6.0` handles `DECRQM` (`\x1b[?2026$p`), DEC 2026 synchronized output,
 *      and Unicode wide glyphs (`○`, `●`, Chinese) without crashing (guards Vite es2022 target).
 *   3. Browser -> Relay -> Agent binary input roundtrip works.
 *   4. Relay restart (new `bootId`) causes browser to auto-reconnect, reset cursors (verified via
 *      CDP WebSocket frames: `web.attach` sent without stale `sinceSeq`), receive fresh replay,
 *      and resume bidirectional input with 0 errors.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireBrowser = process.argv.includes("--require-browser");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForHttp(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitUntil(fn, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

function startRelay(port, token, secret) {
  return spawn(process.execPath, [path.join(root, "packages/relay/dist/index.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      WEB_TOKEN: token,
      AGENT_SECRET: secret,
      SESSION_GRACE_MS: "3000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function connectMockAgent(port, secret, sessionId, initialReplayText) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
    const receivedInputs = [];
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "agent.register",
          hostId: "smoke-host",
          hostName: "smoke-host",
          platform: "win32",
          sessionId,
          title: "smoke-term",
          shell: "pwsh.exe",
          cwd: "C:\\workspace",
          cols: 100,
          rows: 30,
          secret,
        })
      );
      if (initialReplayText) {
        ws.send(
          encodeBinaryFrame(
            FRAME_PTY_REPLAY,
            sessionId,
            new TextEncoder().encode(initialReplayText)
          )
        );
      }
      resolve({
        ws,
        receivedInputs,
        sendOutput(text) {
          ws.send(encodeBinaryFrame(FRAME_PTY_OUTPUT, sessionId, new TextEncoder().encode(text)));
        },
        close() {
          try {
            ws.close();
          } catch {}
        },
      });
    });
    ws.on("message", (raw, isBinary) => {
      if (!isBinary) return;
      const frame = decodeBinaryFrame(new Uint8Array(raw));
      if (frame && frame.frameType === FRAME_PTY_INPUT && frame.sessionId === sessionId) {
        receivedInputs.push(new TextDecoder().decode(frame.payload));
      }
    });
    ws.on("error", reject);
  });
}

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    const msg = "[browser-smoke] No local Chrome/Edge binary found (set CHROME_PATH to override).";
    if (requireBrowser) {
      console.error(msg);
      process.exit(1);
    }
    console.log(`${msg} Skipping.`);
    process.exit(0);
  }

  const distIndex = path.join(root, "packages/web/dist/index.html");
  assert(fs.existsSync(distIndex), "packages/web/dist/index.html missing — run `npm run build` first");

  const relayPort = await getFreePort();
  const cdpPort = await getFreePort();
  const token = "smoke-web-token";
  const secret = "smoke-agent-secret";
  const sessionId = "smoke-sess-01";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rift-browser-smoke-"));

  let relay = null;
  let agent = null;
  let chrome = null;
  let cdp = null;
  let send = null;
  let chromeStderr = "";

  try {
    console.log(`[browser-smoke] Browser: ${browserPath}`);
    relay = startRelay(relayPort, token, secret);
    await waitForHttp(`http://127.0.0.1:${relayPort}/health`);

    agent = await connectMockAgent(
      relayPort,
      secret,
      sessionId,
      "\x1b[2J\x1b[HInitial Boot Banner\r\n"
    );

    const chromeArgs = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      "--window-size=1280,800",
    ];
    if (process.platform === "linux") {
      chromeArgs.push("--no-sandbox", "--disable-dev-shm-usage");
    }
    chromeArgs.push("about:blank");

    chrome = spawn(browserPath, chromeArgs, { stdio: ["ignore", "ignore", "pipe"] });
    chrome.stderr?.on("data", (d) => {
      if (chromeStderr.length < 4000) chromeStderr += d.toString();
    });

    const pageTarget = await waitUntil(async () => {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      const targets = await res.json();
      return targets.find((t) => t.type === "page") ?? null;
    }, `Chrome CDP target (stderr: ${chromeStderr.slice(0, 300)})`);

    cdp = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      cdp.once("open", r);
      cdp.once("error", j);
    });

    let msgId = 1;
    const pending = new Map();
    const errors = [];
    const sentWsControlMsgs = [];
    const receivedBootIds = [];

    send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = msgId++;
        pending.set(id, { resolve, reject });
        cdp.send(JSON.stringify({ id, method, params }));
      });

    cdp.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      } else if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        errors.push(`EXCEPTION: ${d.text} ${d.exception?.description ?? ""}`.trim());
      } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        const text = m.params.args.map((a) => a.value ?? a.description).join(" ");
        errors.push(`CONSOLE.ERROR: ${text}`);
      } else if (m.method === "Log.entryAdded" && m.params.entry?.level === "error") {
        if (!String(m.params.entry.text).includes("WebSocket connection")) {
          errors.push(`LOG.ERROR: ${m.params.entry.text}`);
        }
      } else if (m.method === "Network.webSocketFrameSent" && m.params.response?.opcode === 1) {
        try {
          sentWsControlMsgs.push(JSON.parse(m.params.response.payloadData));
        } catch {}
      } else if (m.method === "Network.webSocketFrameReceived" && m.params.response?.opcode === 1) {
        try {
          const parsed = JSON.parse(m.params.response.payloadData);
          if (parsed.type === "web.auth_ok" && parsed.bootId) {
            receivedBootIds.push(parsed.bootId);
          }
        } catch {}
      }
    });

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Network.enable");

    const expectedOrigin = `http://127.0.0.1:${relayPort}`;
    await send("Page.navigate", { url: `${expectedOrigin}/` });
    await waitUntil(async () => {
      const r = await send("Runtime.evaluate", {
        expression: `location.origin === ${JSON.stringify(expectedOrigin)} && document.readyState === "complete"`,
        returnByValue: true,
      });
      return r.result?.value === true;
    }, "initial page load on relay origin");

    // Authenticate via localStorage token and reload
    const authEval = await send("Runtime.evaluate", {
      expression: `(() => { localStorage.setItem("rift_token", ${JSON.stringify(token)}); location.reload(); })()`,
    });
    assert.equal(authEval.exceptionDetails, undefined, `Auth eval failed: ${JSON.stringify(authEval.exceptionDetails)}`);

    await waitUntil(async () => {
      const r = await send("Runtime.evaluate", {
        expression: `JSON.stringify({
          conn: document.getElementById("conn-label")?.textContent,
          count: document.getElementById("session-count")?.textContent,
          title: document.getElementById("active-title")?.textContent,
          visiblePanes: document.querySelectorAll(".session-term-pane:not(.hidden)").length,
          hasXterm: document.querySelectorAll(".session-term-pane:not(.hidden) .xterm").length
        })`,
        returnByValue: true,
      });
      const d = JSON.parse(r.result?.value || "{}");
      return d.conn === "LIVE" && d.count === "1" && d.visiblePanes === 1 && d.hasXterm === 1;
    }, "web client LIVE + xterm attached");
    console.log("[browser-smoke] 1/3 Web dist loaded, authed, and attached xterm");

    // 2. Feed DECRQM (?2026$p) + DEC 2026 sync output + Unicode glyphs (guards xterm 6.0 / es2022)
    agent.sendOutput(
      "\x1b[?2026$p\x1b[?2026h\x1b[38;2;204;120;92m○\x1b[0m ● Rift Smoke 中文 OK\r\n\x1b[?2026l"
    );
    await sleep(400);
    assert.deepEqual(errors, [], `Browser JS/console errors after DECRQM/DEC2026: ${errors.join("; ")}`);

    // Verify browser -> relay -> agent input roundtrip via composer
    const eval1 = await send("Runtime.evaluate", {
      expression: `(() => {
        const inp = document.getElementById("composer-input");
        inp.value = "ping-before-restart";
        document.getElementById("composer-form").dispatchEvent(new Event("submit", { cancelable: true }));
      })()`,
    });
    assert.equal(eval1.exceptionDetails, undefined, `Eval1 failed: ${JSON.stringify(eval1.exceptionDetails)}`);
    await waitUntil(
      () => agent.receivedInputs.join("").includes("ping-before-restart\r"),
      "agent receives input before restart"
    );
    console.log("[browser-smoke] 2/3 DECRQM + DEC 2026 + Unicode rendered with 0 errors & input verified");

    // 3. Restart Relay on same port (new bootId) -> verify browser disconnects, resets sinceSeq, and resyncs
    const sentBeforeRestart = sentWsControlMsgs.length;
    const bootCountBeforeRestart = receivedBootIds.length;
    assert(bootCountBeforeRestart >= 1, "Expected initial web.auth_ok bootId");

    agent.close();
    relay.kill();
    await new Promise((r) => relay.once("exit", r));

    await waitUntil(async () => {
      const r = await send("Runtime.evaluate", {
        expression: `document.getElementById("conn-label")?.textContent !== "LIVE"`,
        returnByValue: true,
      });
      return r.result?.value === true;
    }, "browser detects Relay disconnect", 5000);

    relay = startRelay(relayPort, token, secret);
    await waitForHttp(`http://127.0.0.1:${relayPort}/health`);
    agent = await connectMockAgent(
      relayPort,
      secret,
      sessionId,
      "\x1b[2J\x1b[H\x1b[?2026$pAFTER_RELAY_RESTART_OK\r\n"
    );

    await waitUntil(async () => {
      const r = await send("Runtime.evaluate", {
        expression: `JSON.stringify({
          conn: document.getElementById("conn-label")?.textContent,
          count: document.getElementById("session-count")?.textContent
        })`,
        returnByValue: true,
      });
      const d = JSON.parse(r.result?.value || "{}");
      return d.conn === "LIVE" && d.count === "1";
    }, "browser auto-reconnect after Relay restart", 10_000);

    // Strictly verify new bootId arrived AND browser reattached with sinceSeq omitted (clean full replay)
    const reattachAfterRestart = await waitUntil(() => {
      if (receivedBootIds.length <= bootCountBeforeRestart) return null;
      return (
        sentWsControlMsgs
          .slice(sentBeforeRestart)
          .find((m) => m.type === "web.attach" && m.sessionId === sessionId) ?? null
      );
    }, "browser sends web.attach after Relay restart", 5000);

    assert.notEqual(
      receivedBootIds[receivedBootIds.length - 1],
      receivedBootIds[bootCountBeforeRestart - 1],
      "Relay restart should issue a new bootId"
    );
    assert.equal(
      reattachAfterRestart.sinceSeq,
      undefined,
      `Expected clean full replay (sinceSeq undefined) after bootId change, got ${JSON.stringify(reattachAfterRestart)}`
    );

    const eval2 = await send("Runtime.evaluate", {
      expression: `(() => {
        const inp = document.getElementById("composer-input");
        inp.value = "ping-after-restart";
        document.getElementById("composer-form").dispatchEvent(new Event("submit", { cancelable: true }));
      })()`,
    });
    assert.equal(eval2.exceptionDetails, undefined, `Eval2 failed: ${JSON.stringify(eval2.exceptionDetails)}`);
    await waitUntil(
      () => agent.receivedInputs.join("").includes("ping-after-restart\r"),
      "agent receives input after Relay restart"
    );

    assert.deepEqual(errors, [], `Browser errors after Relay restart: ${errors.join("; ")}`);
    console.log("[browser-smoke] 3/3 Relay restart new bootId -> clean sinceSeq reset + input verified with 0 errors");
    console.log("[browser-smoke] ALL CHECKS PASSED!");
  } finally {
    try {
      if (send && cdp?.readyState === WebSocket.OPEN) {
        await Promise.race([send("Browser.close"), sleep(500)]);
      }
    } catch {}
    try {
      cdp?.close();
    } catch {}
    try {
      agent?.close();
    } catch {}
    try {
      chrome?.kill();
    } catch {}
    try {
      relay?.kill();
    } catch {}
    await sleep(300);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error("[browser-smoke] FAIL:", err);
  process.exit(1);
});
