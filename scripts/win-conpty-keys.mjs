#!/usr/bin/env node
/**
 * BugTDD #7 regression gate (Windows only):
 * Spawns real `rift.exe` inside an outer ConPTY (simulating Windows Terminal -> rift -> child)
 * and verifies:
 *   1. Esc, Ctrl+C, arrow keys, Home/End, Shift+Tab, and UTF-8 Chinese pass through intact.
 *   2. Child's enhanced keyboard mode requests (Kitty >5u/=5;1u, modifyOtherKeys >4;2m,
 *      win32-input-mode ?9001h) do NOT leak to outer terminal stdout.
 *
 * Skips cleanly on non-Windows platforms (Unix PTY passes sequences natively).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("[win-conpty-keys] Non-Windows platform; skipping Windows ConPTY regression check.");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pty = require(path.join(root, "node_modules/node-pty"));

const releaseBin = path.join(root, "crates/rift/target/release/rift.exe");
const debugBin = path.join(root, "crates/rift/target/debug/rift.exe");
const riftBin = process.env.RIFT_BIN || (fs.existsSync(releaseBin) ? releaseBin : debugBin);

assert(fs.existsSync(riftBin), `rift.exe not found at ${riftBin}; build crates/rift first`);

const childCode = `
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\\x1b[>5u\\x1b[=5;1u\\x1b[>4;2m\\x1b[?9001h\\x1b[?2026hREADY\\x1b[?2026l\\n");
process.stdin.on("data", (buf) => {
  process.stdout.write("GOT:" + buf.toString("hex") + "\\n");
  if (buf.includes(0x04)) process.exit(0);
});
`;

const term = pty.spawn(
  riftBin,
  ["--relay", "ws://127.0.0.1:19999", "--", process.execPath, "-e", childCode],
  {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: root,
    env: process.env,
  }
);

let out = "";
let sent = false;
const cases = [
  ["A", "a", "61"],
  ["ESC", "\x1b", "1b"],
  ["CTRL_C", "\x03", "03"],
  ["UP", "\x1b[A", "1b5b41"],
  ["DOWN", "\x1b[B", "1b5b42"],
  ["HOME", "\x1b[H", "1b5b48"],
  ["END", "\x1b[F", "1b5b46"],
  ["SHIFT_TAB", "\x1b[Z", "1b5b5a"],
  ["ALT_V", "\x1bv", "1b76"],
  ["CTRL_V", "\x16", "16"],
  ["UTF8_ZH", "中文", "e4b8ade69687"],
  ["CTRL_D", "\x04", "04"],
];

const timer = setTimeout(() => {
  console.error("[win-conpty-keys] FAIL: timeout waiting for nested rift exit");
  term.kill();
  process.exit(1);
}, 8000);

term.onData((d) => {
  out += d;
  if (!sent && out.includes("READY")) {
    sent = true;
    let idx = 0;
    const next = () => {
      if (idx >= cases.length) return;
      const [, seq] = cases[idx++];
      term.write(seq);
      setTimeout(next, 160);
    };
    setTimeout(next, 100);
  }
});

term.onExit((e) => {
  clearTimeout(timer);
  const cleanOut = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const gotHexes = [...cleanOut.matchAll(/GOT:([0-9a-f]+)/g)].map((m) => m[1]);

  for (const [label, , expectedHex] of cases) {
    assert(
      gotHexes.includes(expectedHex),
      `Missing exact ${label} (${expectedHex}) in child stdin: ${JSON.stringify(gotHexes)}`
    );
  }
  assert.equal(out.includes("\x1b[>5u"), false, "Kitty >5u leaked to outer terminal");
  assert.equal(out.includes("\x1b[=5;1u"), false, "Kitty =5;1u leaked to outer terminal");
  assert.equal(out.includes("\x1b[>4;2m"), false, "modifyOtherKeys >4;2m leaked to outer terminal");
  assert.equal(out.includes("\x1b[?9001h"), false, "win32-input-mode ?9001h leaked to outer terminal");
  console.log(`[win-conpty-keys] OK (exit=${e.exitCode}, ${cases.length} key/UTF-8 sequences verified, 0 protocol leaks)`);
  process.exit(0);
});
