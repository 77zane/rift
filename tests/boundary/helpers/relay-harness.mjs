/**
 * tests/boundary 真实装配测试夹具：spawn 构建后的 relay dist + 真实 WS 客户端。
 * 全程事件驱动（stdout 就绪 + /health + 消息 inbox + AbortSignal.timeout），不使用固定 setTimeout 睡眠。
 * 非 *.test.mjs，不被 run-gates 当作测试文件收集，但受 check-test-patterns 扫描。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import {
  FRAME_PTY_INPUT,
  FRAME_PTY_OUTPUT,
  FRAME_PTY_REPLAY,
  decodeBinaryFrame,
  encodeBinaryFrame,
} from '@rift/shared';

export { FRAME_PTY_INPUT, FRAME_PTY_OUTPUT, FRAME_PTY_REPLAY };

/** 探测一个空闲端口（PORT=0 会让 relay 日志打印 :0，故先探测再固定端口启动）。 */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 启动真实 relay 子进程，等待 stdout 就绪 + /health ok:true。 */
export async function startRelay(rootDir, { port, graceMs = 300, webToken = 'test-web-token', agentSecret = 'test-agent-secret' } = {}) {
  const child = spawn(process.execPath, ['packages/relay/dist/index.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      WEB_TOKEN: webToken,
      AGENT_SECRET: agentSecret,
      SESSION_GRACE_MS: String(graceMs),
      WEB_DIST: `${rootDir}/packages/web/dist`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const ready = new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(10_000);
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes('listening on')) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.on('exit', (code) => reject(new Error(`relay exited early code=${code}`)));
    signal.addEventListener('abort', () => reject(new Error('relay startup timeout')));
  });
  await ready;

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  if (!health.ok) throw new Error('relay /health not ok');

  return {
    port,
    child,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      const deadline = new Promise((resolve) => {
        AbortSignal.timeout(3000).addEventListener('abort', () => resolve());
      });
      await Promise.race([exited, deadline]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

/** 真实 WS 客户端 + 消息 inbox（json / 二进制帧），nextJson/nextFrame 事件驱动消费。 */
export class WsClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.json = [];
    this.frames = [];
    this.waiters = [];
    this.ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        const frame = decodeBinaryFrame(new Uint8Array(raw));
        if (frame) this.frames.push(frame);
      } else {
        try {
          this.json.push(JSON.parse(raw.toString('utf8')));
        } catch {
          /* 忽略非 JSON 文本 */
        }
      }
      this.#drain();
    });
  }

  #drain() {
    for (let i = 0; i < this.waiters.length; i += 1) {
      const w = this.waiters[i];
      const queue = w.kind === 'json' ? this.json : this.frames;
      const idx = queue.findIndex(w.pred);
      if (idx >= 0) {
        const [item] = queue.splice(idx, 1);
        this.waiters.splice(i, 1);
        i -= 1;
        w.resolve(item);
      }
    }
  }

  #next(kind, pred, ms) {
    const queue = kind === 'json' ? this.json : this.frames;
    const idx = queue.findIndex(pred);
    if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { kind, pred, resolve, reject };
      this.waiters.push(waiter);
      const signal = AbortSignal.timeout(ms);
      signal.addEventListener('abort', () => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error(`WsClient.${kind} wait timeout (${ms}ms)`));
      });
    });
  }

  nextJson(pred, ms = 5000) {
    return this.#next('json', pred, ms);
  }

  nextFrame(pred, ms = 5000) {
    return this.#next('frame', pred, ms);
  }

  sendJson(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  sendFrame(frameType, sessionId, payload) {
    this.ws.send(encodeBinaryFrame(frameType, sessionId, payload));
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await once(this.ws, 'open');
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }

  terminate() {
    this.ws.terminate();
  }
}

/** 连接 agent 端并注册会话（secret 鉴权）。 */
export async function connectAgent(port, secret, register) {
  const client = new WsClient(`ws://127.0.0.1:${port}/ws/agent`);
  await client.open();
  client.sendJson({ ...register, secret });
  return client;
}

/** 连接 web 端并完成 token 鉴权，返回 auth_ok（含 bootId）。 */
export async function connectWeb(port, token) {
  const client = new WsClient(`ws://127.0.0.1:${port}/ws/web`);
  await client.open();
  client.sendJson({ type: 'web.auth', token });
  const authOk = await client.nextJson((m) => m.type === 'web.auth_ok');
  return { client, authOk };
}

export const isOutput = (f) => f.frameType === FRAME_PTY_OUTPUT;
export const isReplay = (f) => f.frameType === FRAME_PTY_REPLAY;
export const isInput = (f) => f.frameType === FRAME_PTY_INPUT;
export const listWithSession = (sid) => (m) =>
  m.type === 'web.list' && m.hosts.some((h) => h.sessions.some((s) => s.sessionId === sid));
export const listWithoutSession = (sid) => (m) =>
  m.type === 'web.list' && !m.hosts.some((h) => h.sessions.some((s) => s.sessionId === sid));
