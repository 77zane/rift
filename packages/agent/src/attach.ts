import readline from "node:readline/promises";
import WebSocket, { type RawData } from "ws";
import {
  FRAME_PTY_INPUT,
  FRAME_PTY_OUTPUT,
  FRAME_PTY_REPLAY,
  decodeBinaryFrame,
  encodeBinaryFrame,
  type ControlMessage,
  type HostGroup,
  type SessionInfo,
} from "@rift/shared";

interface AttachOptions {
  relay: string;
  token: string;
  target?: string;
}

function parseAttachArgs(argv: string[]): AttachOptions {
  let relay = process.env.AGENTSHARE_RELAY ?? "ws://127.0.0.1:7700";
  let token = process.env.AGENTSHARE_TOKEN ?? process.env.WEB_TOKEN ?? "";
  let target: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--relay" && argv[i + 1]) {
      relay = argv[++i];
    } else if (arg === "--token" && argv[i + 1]) {
      token = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        [
          "Usage: agentshare attach [options] [sessionId]",
          "",
          "Options:",
          "  --relay <ws-url>   Relay server URL (default: ws://127.0.0.1:7700 or AGENTSHARE_RELAY)",
          "  --token <token>    Web access token (or AGENTSHARE_TOKEN / WEB_TOKEN)",
          "",
          "Press Ctrl+] while attached to detach without killing the background session.",
        ].join("\n")
      );
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      target = arg;
    }
  }

  return { relay, token, target };
}

function normalizeWebWsUrl(relay: string): string {
  const trimmed = relay.replace(/\/+$/, "");
  if (trimmed.endsWith("/ws/web")) return trimmed;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice(7)}/ws/web`;
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice(8)}/ws/web`;
  return `${trimmed}/ws/web`;
}

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return new Uint8Array(data);
}

export async function runAttach(argv: string[]): Promise<void> {
  const opts = parseAttachArgs(argv);
  const wsUrl = normalizeWebWsUrl(opts.relay);
  const decoder = new TextDecoder();

  const ws = new WebSocket(wsUrl);
  let activeSessionId: string | null = null;
  let choosing = false;
  let detached = false;

  const sendControl = (msg: ControlMessage) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  const cleanup = (message?: string, code = 0) => {
    if (detached) return;
    detached = true;
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      } catch {
        // ignore
      }
    }
    if (ws.readyState === WebSocket.OPEN) {
      if (activeSessionId) {
        sendControl({ type: "web.detach", sessionId: activeSessionId });
      }
      ws.close(1000, "Detached");
    }
    if (message) {
      process.stdout.write(`\r\n${message}\r\n`);
    }
    process.exit(code);
  };

  const beginAttach = (session: SessionInfo) => {
    activeSessionId = session.sessionId;
    process.stdout.write(
      `\x1b[2J\x1b[H[agentshare] 已接管 ${session.hostName} / ${session.title} (${session.sessionId}) — 按 Ctrl+] 脱离（后台继续运行）\r\n`
    );
    sendControl({ type: "web.attach", sessionId: session.sessionId });

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", (chunk: Buffer) => {
        // Ctrl+] (0x1d) detaches cleanly
        if (chunk.includes(0x1d)) {
          cleanup("[agentshare] 已脱离会话（后台会话继续运行）。", 0);
          return;
        }
        if (activeSessionId && ws.readyState === WebSocket.OPEN) {
          ws.send(encodeBinaryFrame(FRAME_PTY_INPUT, activeSessionId, chunk));
        }
      });
    }

    if (process.stdout.isTTY) {
      const syncSize = () => {
        if (!activeSessionId) return;
        const cols = process.stdout.columns;
        const rows = process.stdout.rows;
        if (cols && rows) {
          sendControl({ type: "term.resize", sessionId: activeSessionId, cols, rows });
        }
      };
      process.stdout.on("resize", syncSize);
    }
  };

  const pickSession = async (hosts: HostGroup[]) => {
    if (choosing || activeSessionId) return;
    const all: SessionInfo[] = [];
    for (const h of hosts) {
      for (const s of h.sessions) all.push(s);
    }

    if (all.length === 0) {
      cleanup("[agentshare] 当前没有在线会话。", 1);
      return;
    }

    if (opts.target) {
      const matched = all.find(
        (s) => s.sessionId === opts.target || s.sessionId.startsWith(opts.target!)
      );
      if (!matched) {
        cleanup(`[agentshare] 未找到会话: ${opts.target}`, 1);
        return;
      }
      beginAttach(matched);
      return;
    }

    if (all.length === 1) {
      beginAttach(all[0]);
      return;
    }

    choosing = true;
    console.log("\n在线终端会话列表：");
    all.forEach((s, idx) => {
      console.log(
        `  [${idx + 1}] ${s.hostName} / ${s.title}  (${s.shell} · ${s.cols}x${s.rows} · id=${s.sessionId})`
      );
    });
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question("\n输入序号接管（直接回车选最后一个，q 退出）: ")).trim();
      rl.close();
      if (answer.toLowerCase() === "q") {
        cleanup(undefined, 0);
        return;
      }
      const index = answer === "" ? all.length - 1 : Number(answer) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= all.length) {
        cleanup("[agentshare] 无效序号。", 1);
        return;
      }
      beginAttach(all[index]);
    } catch {
      rl.close();
      cleanup(undefined, 1);
    }
  };

  let authPrompted = false;
  const promptForToken = async (errMsg?: string) => {
    if (authPrompted) return;
    authPrompted = true;
    if (errMsg) console.error(`[agentshare] ${errMsg}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const t = (await rl.question("请输入中转服务 WEB_TOKEN: ")).trim();
    rl.close();
    authPrompted = false;
    sendControl({ type: "web.auth", token: t });
  };

  let authTimeout: NodeJS.Timeout | null = null;

  ws.on("open", () => {
    if (opts.token) {
      sendControl({ type: "web.auth", token: opts.token });
    } else {
      authTimeout = setTimeout(() => {
        if (!activeSessionId && !choosing) {
          void promptForToken();
        }
      }, 600);
    }
  });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      const frame = decodeBinaryFrame(toUint8Array(raw));
      if (!frame || frame.sessionId !== activeSessionId) return;
      if (frame.frameType === FRAME_PTY_REPLAY || frame.frameType === FRAME_PTY_OUTPUT) {
        process.stdout.write(decoder.decode(frame.payload));
      }
      return;
    }

    let msg: ControlMessage;
    try {
      msg = JSON.parse(raw.toString("utf-8")) as ControlMessage;
    } catch {
      return;
    }

    if (msg.type === "web.auth_ok") {
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
      }
      return;
    }

    if (msg.type === "web.auth_err") {
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
      }
      void promptForToken(msg.message);
      return;
    }

    if (msg.type === "web.list") {
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
      }
      if (activeSessionId) {
        const stillAlive = msg.hosts.some((h) =>
          h.sessions.some((s) => s.sessionId === activeSessionId)
        );
        if (!stillAlive) {
          cleanup("[agentshare] 远端会话已关闭。", 0);
        }
      } else {
        void pickSession(msg.hosts);
      }
    }
  });

  ws.on("close", () => {
    cleanup("[agentshare] 与中转服务连接已断开。", 0);
  });

  ws.on("error", (err) => {
    cleanup(`[agentshare] 连接失败: ${err.message}`, 1);
  });
}
