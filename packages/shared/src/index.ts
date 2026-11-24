export const FRAME_PTY_OUTPUT = 0x01;
export const FRAME_PTY_INPUT = 0x02;
export const FRAME_PTY_REPLAY = 0x03;

export type BinaryFrameType =
  | typeof FRAME_PTY_OUTPUT
  | typeof FRAME_PTY_INPUT
  | typeof FRAME_PTY_REPLAY;

export type AgentState = "running" | "tool" | "waiting" | "idle";

export interface SessionInfo {
  sessionId: string;
  hostId: string;
  hostName: string;
  platform: string;
  title: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActiveAt: number;
  headless?: boolean;
  customTitle?: boolean;
  reconnecting?: boolean;
  agentName?: string;
  agentState?: AgentState;
  agentUpdatedAt?: number;
}

export interface HostGroup {
  hostId: string;
  hostName: string;
  platform: string;
  sessions: SessionInfo[];
}

export type ControlMessage =
  | {
      type: "host.online";
      hostId: string;
      hostName: string;
      platform: string;
      secret?: string;
    }
  | {
      type: "agent.register";
      hostId: string;
      hostName: string;
      platform: string;
      sessionId: string;
      title: string;
      shell: string;
      cwd: string;
      cols: number;
      rows: number;
      headless?: boolean;
      customTitle?: boolean;
      secret?: string;
    }
  | {
      type: "agent.update";
      sessionId: string;
      title?: string;
      cwd?: string;
      cols?: number;
      rows?: number;
    }
  | {
      type: "agent.heartbeat";
      sessionId: string;
    }
  | {
      type: "agent.state";
      sessionId: string;
      agent: string;
      state: AgentState;
      secret?: string;
    }
  | {
      type: "web.auth";
      token?: string;
    }
  | {
      type: "web.auth_ok";
      authRequired: boolean;
      bootId?: string;
    }
  | {
      type: "web.auth_err";
      message: string;
    }
  | {
      type: "web.list";
      hosts: HostGroup[];
    }
  | {
      type: "web.attach";
      sessionId: string;
      sinceSeq?: number;
    }
  | {
      type: "web.sync";
      sessionId: string;
      seq: number;
    }
  | {
      type: "web.detach";
      sessionId: string;
    }
  | {
      type: "term.resize";
      sessionId: string;
      cols: number;
      rows: number;
    }
  | {
      type: "host.spawn";
      hostId: string;
      shell?: string;
      cwd?: string;
    }
  | {
      type: "term.close";
      sessionId: string;
    }
  | {
      type: "term.rename";
      sessionId: string;
      title: string;
    }
  | {
      type: "term.paste_image";
      sessionId: string;
      mime: string;
      data: string;
    }
  | {
      type: "error";
      message: string;
    };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Binary frame wire format:
 * [0]               : frameType (1 byte)
 * [1]               : sessionId byte length N (1 byte, max 255)
 * [2 .. 2 + N)      : sessionId UTF-8 bytes
 * [2 + N .. end)    : raw PTY bytes
 */
export function encodeBinaryFrame(
  frameType: BinaryFrameType,
  sessionId: string,
  payload: Uint8Array
): Uint8Array {
  const idBytes = encoder.encode(sessionId);
  if (idBytes.length > 255) {
    throw new Error("sessionId too long");
  }
  const out = new Uint8Array(2 + idBytes.length + payload.length);
  out[0] = frameType;
  out[1] = idBytes.length;
  out.set(idBytes, 2);
  out.set(payload, 2 + idBytes.length);
  return out;
}

export function decodeBinaryFrame(
  raw: Uint8Array
): { frameType: BinaryFrameType; sessionId: string; payload: Uint8Array } | null {
  if (raw.length < 2) return null;
  const frameType = raw[0] as BinaryFrameType;
  const idLen = raw[1];
  if (raw.length < 2 + idLen) return null;
  const sessionId = decoder.decode(raw.subarray(2, 2 + idLen));
  const payload = raw.subarray(2 + idLen);
  return { frameType, sessionId, payload };
}

/**
 * Bounded byte ring buffer for instant terminal replay and incremental delta sync.
 */
export class ByteRingBuffer {
  private chunks: Uint8Array[] = [];
  private totalBytes = 0;
  private totalWritten = 0;

  constructor(private readonly maxBytes = 4 * 1024 * 1024) {}

  get headOffset(): number {
    return this.totalWritten;
  }

  get tailOffset(): number {
    return this.totalWritten - this.totalBytes;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const copy = new Uint8Array(chunk);
    this.chunks.push(copy);
    this.totalBytes += copy.length;
    this.totalWritten += copy.length;
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const removed = this.chunks.shift()!;
      this.totalBytes -= removed.length;
    }
  }

  replace(data: Uint8Array): void {
    this.chunks = [];
    this.totalBytes = 0;
    // Advance offset past any previous viewer's sinceSeq so stale viewers trigger full replay
    this.totalWritten += this.maxBytes + 1;
    if (data.length <= this.maxBytes) {
      this.push(data);
    } else {
      this.push(data.subarray(data.length - this.maxBytes));
    }
  }

  sliceSince(offset: number): Uint8Array | null {
    if (offset < this.tailOffset || offset > this.totalWritten) {
      return null;
    }
    const needed = this.totalWritten - offset;
    if (needed === 0) return new Uint8Array(0);

    const out = new Uint8Array(needed);
    let skip = offset - this.tailOffset;
    let outPos = 0;
    for (const c of this.chunks) {
      if (skip >= c.length) {
        skip -= c.length;
        continue;
      }
      const part = skip > 0 ? c.subarray(skip) : c;
      skip = 0;
      out.set(part, outPos);
      outPos += part.length;
    }
    return out;
  }

  snapshot(): Uint8Array {
    const out = new Uint8Array(this.totalBytes);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
