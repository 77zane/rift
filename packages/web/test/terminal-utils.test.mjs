import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveSizeMode,
  sanitizePastedText,
  shouldResetSessionCursors,
} from "../src/terminal-utils.ts";

test("BugTDD #4: voice-IME dictation trailing newlines never auto-submit", () => {
  assert.equal(sanitizePastedText("帮我看下这个报错\r\n", false), "帮我看下这个报错");
  assert.equal(sanitizePastedText("hello world\n\n", false), "hello world");
  assert.equal(sanitizePastedText("\r\n\n", false), null);
});

test("BugTDD #4: multiline paste collapses newlines when bracketed paste is off", () => {
  const res = sanitizePastedText("line 1\r\nline 2\nline 3\n", false);
  assert.equal(res, "line 1 line 2 line 3");
  assert.equal(res.includes("\r"), false);
  assert.equal(res.includes("\n"), false);
});

test("BugTDD #4: multiline paste uses atomic bracketed paste without trailing Enter or escape breakout", () => {
  const res = sanitizePastedText("line 1\r\nline 2\r\n", true);
  assert.equal(res, "\x1b[200~line 1\nline 2\x1b[201~");

  // Embedded ESC[201~ must be stripped so pasted text cannot break out of bracketed paste
  const escaped = sanitizePastedText("safe\x1b[201~rm -rf /\x1b[200~tail", true);
  assert.equal(escaped, "\x1b[200~saferm -rf /tail\x1b[201~");
});

test("BugTDD #2: shouldResetSessionCursors only triggers when Relay bootId changes", () => {
  assert.equal(shouldResetSessionCursors(null, "boot-1"), false);
  assert.equal(shouldResetSessionCursors("boot-1", "boot-1"), false);
  assert.equal(shouldResetSessionCursors("boot-1", undefined), false);
  assert.equal(shouldResetSessionCursors("boot-1", "boot-2"), true);
});

test("resolveSizeMode defaults headless to fit-local, desktop to follow-host, and respects overrides", () => {
  const overrides = new Map();
  assert.equal(resolveSizeMode(null, overrides), "follow-host");
  assert.equal(resolveSizeMode({ sessionId: "s1", headless: false }, overrides), "follow-host");
  assert.equal(resolveSizeMode({ sessionId: "s2", headless: true }, overrides), "fit-local");

  overrides.set("s1", "fit-local");
  overrides.set("s2", "follow-host");
  assert.equal(resolveSizeMode({ sessionId: "s1", headless: false }, overrides), "fit-local");
  assert.equal(resolveSizeMode({ sessionId: "s2", headless: true }, overrides), "follow-host");
});
