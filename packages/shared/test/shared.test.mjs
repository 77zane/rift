import test from "node:test";
import assert from "node:assert/strict";
import {
  ByteRingBuffer,
  FRAME_PTY_INPUT,
  FRAME_PTY_OUTPUT,
  FRAME_PTY_REPLAY,
  decodeBinaryFrame,
  encodeBinaryFrame,
} from "../dist/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

test("binary frame encode/decode roundtrip for output, input, replay", () => {
  for (const frameType of [FRAME_PTY_OUTPUT, FRAME_PTY_INPUT, FRAME_PTY_REPLAY]) {
    const payload = enc.encode("hello 中文 \x1b[32mgreen\x1b[0m");
    const encoded = encodeBinaryFrame(frameType, "sess-01", payload);
    const decoded = decodeBinaryFrame(encoded);
    assert.ok(decoded);
    assert.equal(decoded.frameType, frameType);
    assert.equal(decoded.sessionId, "sess-01");
    assert.deepEqual(decoded.payload, payload);
  }
});

test("decodeBinaryFrame rejects truncated or malformed frames safely", () => {
  assert.equal(decodeBinaryFrame(new Uint8Array([])), null);
  assert.equal(decodeBinaryFrame(new Uint8Array([FRAME_PTY_OUTPUT])), null);
  // Claims idLen = 10, but only 2 bytes follow
  assert.equal(decodeBinaryFrame(new Uint8Array([FRAME_PTY_OUTPUT, 10, 0x61, 0x62])), null);
});

test("encodeBinaryFrame rejects sessionId longer than 255 UTF-8 bytes", () => {
  assert.throws(() => encodeBinaryFrame(FRAME_PTY_INPUT, "x".repeat(256), new Uint8Array([1])));
});

test("BugTDD #1: default ByteRingBuffer retains >512KB high-frequency ANSI stream losslessly", () => {
  const rb = new ByteRingBuffer(); // default 4MB
  const line = "\x1b[38;2;204;120;92m●\x1b[0m 中文输出 line-payload-0123456789abcdef\r\n";
  const chunk = enc.encode(line);
  // Push ~1MB (> 256KB old buggy limit and > 512KB)
  const count = Math.ceil((1024 * 1024) / chunk.length);
  for (let i = 0; i < count; i++) {
    rb.push(chunk);
  }
  const snap = rb.snapshot();
  assert.equal(snap.length, count * chunk.length);
  assert.ok(snap.length > 512 * 1024);
  assert.equal(dec.decode(snap.subarray(0, chunk.length)), line);
  assert.equal(dec.decode(snap.subarray(snap.length - chunk.length)), line);
  assert.equal(rb.tailOffset, 0);
  assert.equal(rb.headOffset, snap.length);
});

test("ByteRingBuffer evicts oldest chunks when exceeding maxBytes and supports sliceSince", () => {
  const rb = new ByteRingBuffer(10);
  rb.push(enc.encode("1234")); // offset 0..4
  const afterFirst = rb.headOffset;
  rb.push(enc.encode("5678")); // offset 4..8
  assert.equal(dec.decode(rb.sliceSince(afterFirst)), "5678");
  assert.equal(rb.sliceSince(rb.headOffset).length, 0);

  rb.push(enc.encode("90ab")); // total 12 -> evicts "1234", tail=4, head=12
  assert.equal(dec.decode(rb.snapshot()), "567890ab");
  assert.equal(rb.sliceSince(0), null); // evicted
  assert.equal(rb.sliceSince(999), null); // ahead of head
  assert.equal(dec.decode(rb.sliceSince(6)), "7890ab");
});

test("BugTDD #2: ByteRingBuffer.replace() advances offset so stale sinceSeq forces full replay", () => {
  const rb = new ByteRingBuffer(1024);
  rb.push(enc.encode("initial-screen-content"));
  const viewerSeq = rb.headOffset;

  // Agent reconnects and uploads fresh replay buffer
  rb.replace(enc.encode("reconnected-screen"));
  assert.equal(
    rb.sliceSince(viewerSeq),
    null,
    "stale viewer sinceSeq must return null to force full replay instead of truncated delta"
  );
  assert.equal(dec.decode(rb.snapshot()), "reconnected-screen");
});
