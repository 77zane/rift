/**
 * tests/boundary —— 真实装配出口回归（spawn 构建后的 relay dist + 真实 WS agent/viewer）。
 * 钉住 docs/SPEC.md §2 不变量：4MiB 无损冷回放、sinceSeq 增量、bootId 重启复位、
 * 断线宽限与进程脱离、customTitle 保护、web→agent 输入往返。
 *
 * 哲学：若有人在 relay 装配出口偷偷加 256KiB 尾部截断，底层 ByteRingBuffer 单测仍绿，
 * 但本测试会立刻红灯拦截。全程事件驱动，无固定 setTimeout 睡眠。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FRAME_PTY_OUTPUT,
  FRAME_PTY_REPLAY,
  FRAME_PTY_INPUT,
  getFreePort,
  startRelay,
  connectAgent,
  connectWeb,
  isOutput,
  isReplay,
  isInput,
  listWithSession,
  listWithoutSession,
} from './helpers/relay-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRET = 'test-agent-secret';
const TOKEN = 'test-web-token';
const MiB = 1024 * 1024;
const SID = 'sess-1';
const REG = {
  type: 'agent.register',
  hostId: 'host-1',
  hostName: 'TestHost',
  platform: 'win32',
  sessionId: SID,
  title: 'Test Shell',
  shell: 'pwsh',
  cwd: 'C:\\',
  cols: 80,
  rows: 24,
};

const sessionIn = (m, pred) =>
  m.type === 'web.list' && m.hosts.some((h) => h.sessions.some((s) => s.sessionId === SID && pred(s)));

/** 附带 viewer 推送 count 个 chunk 并逐帧收齐（事件驱动屏障），确保 ring 已写满后 detach。 */
async function fillRing(agent, viewer, { chunk = 64 * 1024, count = 96 } = {}) {
  viewer.sendJson({ type: 'web.attach', sessionId: SID });
  await viewer.nextJson((m) => m.type === 'web.sync');
  let received = 0;
  for (let i = 0; i < count; i += 1) {
    const buf = Buffer.alloc(chunk, 0x41 + (i % 26));
    if (i === 0) buf.write('HEAD_MARKER');
    if (i === count - 1) buf.write('TAIL_MARKER', chunk - 11);
    agent.sendFrame(FRAME_PTY_OUTPUT, SID, buf);
    const f = await viewer.nextFrame(isOutput);
    received += f.payload.length;
  }
  viewer.sendJson({ type: 'web.detach', sessionId: SID });
  return received;
}

test('冷 attach 返回 4MiB 无损回放（头部被逐、尾部完整）', async (t) => {
  const port = await getFreePort();
  const relay = await startRelay(ROOT, { port });
  t.after(() => relay.stop());
  const agent = await connectAgent(port, SECRET, REG);
  t.after(() => agent.terminate());
  const { client: viewerA } = await connectWeb(port, TOKEN);
  t.after(() => viewerA.close());
  await viewerA.nextJson(listWithSession(SID));

  const received = await fillRing(agent, viewerA);
  assert.equal(received, 6 * MiB);

  const { client: viewerB } = await connectWeb(port, TOKEN);
  t.after(() => viewerB.close());
  viewerB.sendJson({ type: 'web.attach', sessionId: SID });
  const replay = await viewerB.nextFrame(isReplay);
  const sync = await viewerB.nextJson((m) => m.type === 'web.sync');

  assert.ok(
    replay.payload.length >= 4 * MiB - 64 * 1024 && replay.payload.length <= 4 * MiB,
    `回放字节数 ${replay.payload.length} 应落在 [4MiB-64KiB, 4MiB]`,
  );
  const text = Buffer.from(replay.payload).toString('latin1');
  assert.ok(text.includes('TAIL_MARKER'), '尾部标记必须保留');
  assert.ok(!text.includes('HEAD_MARKER'), '头部标记必须被逐出');
  assert.equal(sync.seq, 6 * MiB);
});

test('sinceSeq 增量仅返回 delta OUTPUT；陈旧游标强制全量 REPLAY', async (t) => {
  const port = await getFreePort();
  const relay = await startRelay(ROOT, { port });
  t.after(() => relay.stop());
  const agent = await connectAgent(port, SECRET, REG);
  t.after(() => agent.terminate());
  const { client: w } = await connectWeb(port, TOKEN);
  t.after(() => w.close());
  await w.nextJson(listWithSession(SID));
  await fillRing(agent, w);

  // 有效游标：尾部 128KiB 增量，必须以 OUTPUT（非 REPLAY）返回
  w.sendJson({ type: 'web.attach', sessionId: SID, sinceSeq: 6 * MiB - 128 * 1024 });
  const delta = await w.nextFrame(isOutput);
  const sync1 = await w.nextJson((m) => m.type === 'web.sync');
  assert.equal(delta.payload.length, 128 * 1024);
  assert.equal(sync1.seq, 6 * MiB);

  // 陈旧游标 0 < tailOffset(2MiB) → 全量 REPLAY
  w.sendJson({ type: 'web.attach', sessionId: SID, sinceSeq: 0 });
  const full = await w.nextFrame(isReplay);
  const sync2 = await w.nextJson((m) => m.type === 'web.sync');
  assert.equal(full.payload.length, 4 * MiB);
  assert.equal(sync2.seq, 6 * MiB);
});

test('relay 重启变更 bootId，replace() 推进偏移使陈旧 sinceSeq 强制全量回放', async (t) => {
  const port = await getFreePort();
  let relay = await startRelay(ROOT, { port });
  const agent = await connectAgent(port, SECRET, REG);
  const { client: w, authOk: a1 } = await connectWeb(port, TOKEN);
  await w.nextJson(listWithSession(SID));
  await fillRing(agent, w, { count: 32 }); // 2MiB
  const bootId1 = a1.bootId;
  assert.ok(bootId1);

  agent.terminate();
  w.close();
  await relay.stop();

  relay = await startRelay(ROOT, { port });
  t.after(() => relay.stop());
  const agent2 = await connectAgent(port, SECRET, REG);
  t.after(() => agent2.terminate());
  const { client: w2, authOk: a2 } = await connectWeb(port, TOKEN);
  t.after(() => w2.close());
  assert.notEqual(a2.bootId, bootId1, '重启后 bootId 必须变化');
  await w2.nextJson(listWithSession(SID));

  // 先 attach 成为 viewer，再用 REPLAY+OUTPUT 同源顺序做事件屏障
  w2.sendJson({ type: 'web.attach', sessionId: SID });
  await w2.nextJson((m) => m.type === 'web.sync');
  const snap = Buffer.alloc(2 * MiB, 0x42);
  snap.write('REPLAY_SNAPSHOT');
  agent2.sendFrame(FRAME_PTY_REPLAY, SID, snap);
  const barrier = Buffer.from('BARRIER_MARKER');
  agent2.sendFrame(FRAME_PTY_OUTPUT, SID, barrier);
  await w2.nextFrame((f) => isOutput(f) && Buffer.from(f.payload).toString('latin1').includes('BARRIER_MARKER'));

  // 陈旧 sinceSeq=2MiB < replace() 推进后的 tailOffset(4MiB+1) → 全量 REPLAY
  w2.sendJson({ type: 'web.attach', sessionId: SID, sinceSeq: 2 * MiB });
  const replay = await w2.nextFrame(isReplay);
  const sync = await w2.nextJson((m) => m.type === 'web.sync');
  const text = Buffer.from(replay.payload).toString('latin1');
  assert.ok(text.includes('REPLAY_SNAPSHOT'), '全量回放须含 agent 快照');
  assert.ok(text.includes('BARRIER_MARKER'));
  assert.equal(replay.payload.length, 2 * MiB + barrier.length);
  assert.equal(sync.seq, 6 * MiB + 1 + barrier.length);
});

test('agent 异常断线保留 reconnecting 会话，宽限到期后才移除', async (t) => {
  const port = await getFreePort();
  const relay = await startRelay(ROOT, { port, graceMs: 300 });
  t.after(() => relay.stop());
  const agent = await connectAgent(port, SECRET, REG);
  const { client: w } = await connectWeb(port, TOKEN);
  t.after(() => w.close());
  await w.nextJson(listWithSession(SID));
  w.sendJson({ type: 'web.attach', sessionId: SID });
  await w.nextJson((m) => m.type === 'web.sync');

  agent.terminate(); // 异常断线（非 1000）
  const reconnecting = await w.nextJson((m) => sessionIn(m, (s) => s.reconnecting === true));
  assert.ok(reconnecting, '宽限期内会话须标记 reconnecting 且保留');

  const removed = await w.nextJson(listWithoutSession(SID), 3000);
  assert.ok(removed, '宽限到期后会话须被移除');
});

test('宽限内重注册保留 viewer 与 customTitle，并向下推送 term.rename', async (t) => {
  const port = await getFreePort();
  const relay = await startRelay(ROOT, { port, graceMs: 5000 });
  t.after(() => relay.stop());
  const agent = await connectAgent(port, SECRET, REG);
  const { client: w } = await connectWeb(port, TOKEN);
  t.after(() => w.close());
  await w.nextJson(listWithSession(SID));
  w.sendJson({ type: 'web.attach', sessionId: SID });
  await w.nextJson((m) => m.type === 'web.sync');

  w.sendJson({ type: 'term.rename', sessionId: SID, title: '我的核心窗口' });
  await w.nextJson((m) => sessionIn(m, (s) => s.customTitle === true && s.title === '我的核心窗口'));
  await agent.nextJson((m) => m.type === 'term.rename' && m.title === '我的核心窗口');

  agent.terminate();
  await w.nextJson((m) => sessionIn(m, (s) => s.reconnecting === true));

  const agent2 = await connectAgent(port, SECRET, { ...REG, title: 'Ignored', customTitle: false });
  t.after(() => agent2.terminate());
  await agent2.nextJson((m) => m.type === 'term.rename' && m.title === '我的核心窗口');
  await w.nextJson((m) => sessionIn(m, (s) => s.customTitle === true && s.title === '我的核心窗口' && s.reconnecting !== true));

  // viewer 仍附着：重注册后的输出须送达
  agent2.sendFrame(FRAME_PTY_OUTPUT, SID, Buffer.from('AFTER_RECONNECT'));
  const f = await w.nextFrame(isOutput);
  assert.ok(Buffer.from(f.payload).toString('latin1').includes('AFTER_RECONNECT'));
});

test('web→agent 二进制 INPUT 帧往返', async (t) => {
  const port = await getFreePort();
  const relay = await startRelay(ROOT, { port });
  t.after(() => relay.stop());
  const agent = await connectAgent(port, SECRET, REG);
  t.after(() => agent.terminate());
  const { client: w } = await connectWeb(port, TOKEN);
  t.after(() => w.close());
  await w.nextJson(listWithSession(SID));
  w.sendJson({ type: 'web.attach', sessionId: SID });
  await w.nextJson((m) => m.type === 'web.sync');

  w.sendFrame(FRAME_PTY_INPUT, SID, Buffer.from('hello\r'));
  const f = await agent.nextFrame(isInput);
  assert.equal(Buffer.from(f.payload).toString('utf8'), 'hello\r');
});
