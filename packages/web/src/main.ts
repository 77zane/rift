import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
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

const isMobileViewport = () => window.innerWidth < 768;

const sidebarEl = document.getElementById("sidebar") as HTMLElement;
const backdropEl = document.getElementById("sidebar-backdrop") as HTMLElement;
const hostListEl = document.getElementById("host-list") as HTMLElement;
const sessionCountEl = document.getElementById("session-count") as HTMLElement;
const connDotEl = document.getElementById("conn-dot") as HTMLElement;
const connLabelEl = document.getElementById("conn-label") as HTMLElement;
const activeTitleEl = document.getElementById("active-title") as HTMLElement;
const emptyStateEl = document.getElementById("empty-state") as HTMLElement;
const termContainerEl = document.getElementById("terminal-container") as HTMLElement;
const mobileBarEl = document.getElementById("mobile-bar") as HTMLElement;
const btnSidebar = document.getElementById("btn-sidebar") as HTMLButtonElement;
const btnSizeMode = document.getElementById("btn-size-mode") as HTMLButtonElement;
const btnMobileBar = document.getElementById("btn-mobile-bar") as HTMLButtonElement;
const btnTheme = document.getElementById("btn-theme") as HTMLButtonElement;
const composerForm = document.getElementById("composer-form") as HTMLFormElement;
const composerInput = document.getElementById("composer-input") as HTMLInputElement;
const authModalEl = document.getElementById("auth-modal") as HTMLElement;
const authFormEl = document.getElementById("auth-form") as HTMLFormElement;
const authInputEl = document.getElementById("auth-input") as HTMLInputElement;
const authErrorEl = document.getElementById("auth-error") as HTMLElement;
const btnPickImage = document.getElementById("btn-pick-image") as HTMLButtonElement | null;
const imageFileInput = document.getElementById("image-file-input") as HTMLInputElement | null;
const toastEl = document.getElementById("toast") as HTMLElement | null;

const textEncoder = new TextEncoder();

let ws: WebSocket | null = null;
let hosts: HostGroup[] = [];
let activeSessionId: string | null = null;
let initialHashSessionId: string | null = location.hash
  ? decodeURIComponent(location.hash.slice(1))
  : null;
let pendingSpawnHostId: string | null = null;
let pendingSpawnKnownIds = new Set<string>();
const prevAgentStates = new Map<string, string>();
let unreadTitleAlert: string | null = null;
let toastTimer: number | null = null;
// Per-session manual size mode overrides.
// Default policy:
//   - Remote `+` (headless) sessions -> "fit-local" (fills 100% of browser screen!)
//   - Local desktop (WT/Ghostty) sessions -> "follow-host" (never squishes local desktop layout!)
const sizeModeOverrides = new Map<string, "follow-host" | "fit-local">();
const lastHostSizes = new Map<string, { cols: number; rows: number }>();
let sizeMode: "follow-host" | "fit-local" = "follow-host";
let mobileBarVisible = isMobileViewport();
let reconnectTimer: number | null = null;
let needsReattach = false;
let relayBootId: string | null = null;
let authToken = localStorage.getItem("rift_token") ?? localStorage.getItem("agentshare_token") ?? "";

let themeName: "ember" | "phosphor" =
  localStorage.getItem("rift_theme") === "phosphor" ? "phosphor" : "ember";

const XTERM_THEMES = {
  ember: {
    background: "#141413",
    foreground: "#eae7df",
    cursor: "#cc785c",
    selectionBackground: "rgba(204, 120, 92, 0.32)",
    black: "#1a1917",
    red: "#ec6f74",
    green: "#9aca86",
    yellow: "#e8c96b",
    blue: "#61aaf2",
    magenta: "#c297ff",
    cyan: "#6dd3ce",
    white: "#eae7df",
  },
  phosphor: {
    background: "#070a08",
    foreground: "#d7f5e1",
    cursor: "#39d98a",
    selectionBackground: "rgba(57, 217, 138, 0.28)",
    black: "#0b100d",
    red: "#ff6b72",
    green: "#39d98a",
    yellow: "#e8c96b",
    blue: "#5ec2ff",
    magenta: "#c594ff",
    cyan: "#4be3c4",
    white: "#d7f5e1",
  },
};

interface SessionTerminal {
  term: Terminal;
  fitAddon: FitAddon;
  pane: HTMLDivElement;
  decoder: TextDecoder;
  lastSeq: number | null;
  webglAddon: WebglAddon | null;
}

const sessionTerms = new Map<string, SessionTerminal>();

function getOrCreateSessionTerm(sessionId: string): SessionTerminal {
  const existing = sessionTerms.get(sessionId);
  if (existing) return existing;

  const pane = document.createElement("div");
  pane.className = "session-term-pane hidden";
  termContainerEl.appendChild(pane);

  const term = new Terminal({
    cursorBlink: true,
    fontSize: isMobileViewport() ? 12 : 15,
    lineHeight: isMobileViewport() ? 1.25 : 1.2,
    fontFamily: '"JetBrains Mono", "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace',
    scrollback: 10000,
    theme: XTERM_THEMES[themeName],
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  // Ctrl+Click (Windows/Linux) or Cmd+Click (macOS) opens links in a new tab; plain tap works on mobile.
  term.loadAddon(
    new WebLinksAddon((ev: MouseEvent, uri: string) => {
      if (isMobileViewport() || ev.ctrlKey || ev.metaKey) {
        window.open(uri, "_blank", "noopener,noreferrer");
      }
    })
  );
  term.open(pane);

  term.onData((data) => {
    if (activeSessionId === sessionId) {
      sendTerminalInput(data);
    }
  });

  // Enable Shift+Enter newline, native paste & voice-IME dictation (Typeless, Wispr Flow, etc.)
  term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
    if (
      ev.key === "Enter" &&
      ev.shiftKey &&
      !ev.ctrlKey &&
      !ev.metaKey &&
      !ev.altKey &&
      !ev.isComposing &&
      ev.keyCode !== 229
    ) {
      if (ev.type === "keydown") {
        ev.preventDefault();
        sendTerminalInput("\x1b[27;2;13~");
      }
      return false;
    }

    const key = ev.key.toLowerCase();
    const mod = ev.ctrlKey || ev.metaKey;

    // Allow native paste (Ctrl+V, Ctrl+Shift+V, Cmd+V)
    if (mod && !ev.altKey && key === "v") {
      return false;
    }

    // Allow native copy (Cmd+C, Ctrl+Shift+C, or Ctrl+C when terminal has a selection)
    if (mod && !ev.altKey && key === "c") {
      if (ev.metaKey || ev.shiftKey || term.hasSelection()) {
        return false;
      }
    }

    return true;
  });

  const entry: SessionTerminal = {
    term,
    fitAddon,
    pane,
    decoder: new TextDecoder(),
    lastSeq: null,
    webglAddon: null,
  };
  sessionTerms.set(sessionId, entry);
  return entry;
}

function enableWebglFor(entry: SessionTerminal): void {
  if (entry.webglAddon) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      try {
        webgl.dispose();
      } catch {
        // ignore
      }
      if (entry.webglAddon === webgl) {
        entry.webglAddon = null;
      }
    });
    entry.term.loadAddon(webgl);
    entry.webglAddon = webgl;
  } catch {
    // WebGL unavailable; gracefully stay on DOM renderer
  }
}

function disableWebglFor(entry: SessionTerminal): void {
  if (!entry.webglAddon) return;
  try {
    entry.webglAddon.dispose();
  } catch {
    // ignore
  }
  entry.webglAddon = null;
}

function getActiveSessionTerm(): SessionTerminal | null {
  return activeSessionId ? sessionTerms.get(activeSessionId) ?? null : null;
}

function disposeStaleSessionTerms(validIds: Set<string>): void {
  for (const [id, entry] of sessionTerms) {
    if (!validIds.has(id)) {
      disableWebglFor(entry);
      entry.term.dispose();
      entry.pane.remove();
      sessionTerms.delete(id);
    }
  }
}

function applyTheme(): void {
  document.documentElement.dataset.theme = themeName;
  btnTheme.textContent = themeName === "ember" ? "EMBER" : "PHOSPHOR";
  for (const entry of sessionTerms.values()) {
    entry.term.options.theme = XTERM_THEMES[themeName];
  }
  localStorage.setItem("rift_theme", themeName);
}

function sendControl(msg: ControlMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendTerminalInput(text: string): void {
  if (!activeSessionId || !ws || ws.readyState !== WebSocket.OPEN) return;
  const payload = textEncoder.encode(text);
  ws.send(encodeBinaryFrame(FRAME_PTY_INPUT, activeSessionId, payload));
}

function showToast(message: string, durationMs = 2400): void {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  if (toastTimer !== null) {
    clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    toastEl.classList.add("hidden");
    toastTimer = null;
  }, durationMs);
}

function updateDocumentTitle(): void {
  if (unreadTitleAlert && document.hidden) {
    document.title = unreadTitleAlert;
    return;
  }
  unreadTitleAlert = null;
  const current = findSession(activeSessionId);
  document.title = current ? `${current.title} // Rift` : "Rift // terminal mirror";
}

function uploadPastedImage(file: File): void {
  if (!activeSessionId) {
    showToast("请先选择一个终端会话");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast("图片超过 10MB 限制", 3000);
    return;
  }
  showToast("正在上传图片…", 5000);
  const reader = new FileReader();
  reader.onload = () => {
    const result = typeof reader.result === "string" ? reader.result : "";
    const commaIdx = result.indexOf(",");
    if (commaIdx < 0 || !activeSessionId) return;
    const base64 = result.slice(commaIdx + 1);
    sendControl({
      type: "term.paste_image",
      sessionId: activeSessionId,
      mime: file.type || "image/png",
      data: base64,
    });
    showToast("图片已发送至终端");
  };
  reader.onerror = () => {
    showToast("图片读取失败", 3000);
  };
  reader.readAsDataURL(file);
}

// Single unified paste handler (capture phase) for text, voice-IME dictation (Typeless), AND images:
// 1. Supports pasting screenshots/images into both the terminal and the bottom composer input;
// 2. Strips trailing newlines so dictation NEVER auto-submits with Enter;
// 3. Uses atomic Bracketed Paste when supported, or collapses internal newlines to spaces when not.
window.addEventListener(
  "paste",
  (ev: ClipboardEvent) => {
    const target = ev.target as HTMLElement | null;
    if (target === authInputEl) return;

    // 1. Check for image items in clipboard first (works in both terminal AND composerInput!)
    const items = ev.clipboardData?.items;
    if (items && activeSessionId) {
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            uploadPastedImage(file);
            return;
          }
        }
      }
    }

    const activeTerm = getActiveSessionTerm()?.term;

    // 2. Let normal text paste work inside composerInput / other inputs
    if (
      target &&
      (target === composerInput ||
        (target.tagName === "INPUT" && target !== activeTerm?.textarea) ||
        (target.tagName === "TEXTAREA" && target !== activeTerm?.textarea))
    ) {
      return;
    }

    const raw = ev.clipboardData?.getData("text/plain");
    if (!raw || !activeSessionId || !activeTerm) return;

    ev.preventDefault();
    ev.stopImmediatePropagation();

    // Never auto-submit on trailing CR/LF
    const trimmedEnd = raw.replace(/[\r\n]+$/, "");
    if (!trimmedEnd) return;

    if (activeTerm.modes.bracketedPasteMode) {
      const normalized = trimmedEnd.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      sendTerminalInput(`\x1b[200~${normalized}\x1b[201~`);
    } else {
      // Without bracketed paste, any CR/LF acts as Enter and submits immediately.
      const singleLine = trimmedEnd.replace(/[\r\n]+/g, " ");
      sendTerminalInput(singleLine);
    }
    activeTerm.focus();
  },
  { capture: true }
);

// Also support dragging & dropping an image directly onto the terminal
termContainerEl.addEventListener("dragover", (ev) => {
  if (ev.dataTransfer?.types.includes("Files")) {
    ev.preventDefault();
  }
});
termContainerEl.addEventListener("drop", (ev) => {
  const files = ev.dataTransfer?.files;
  if (!files || files.length === 0) return;
  for (const file of Array.from(files)) {
    if (file.type.startsWith("image/")) {
      ev.preventDefault();
      uploadPastedImage(file);
    }
  }
});

function findSession(id: string | null): SessionInfo | null {
  if (!id) return null;
  for (const h of hosts) {
    for (const s of h.sessions) {
      if (s.sessionId === id) return s;
    }
  }
  return null;
}

function resolveSizeModeFor(sess: SessionInfo | null): "follow-host" | "fit-local" {
  if (!sess) return "follow-host";
  const manual = sizeModeOverrides.get(sess.sessionId);
  if (manual) return manual;
  // Remote-spawned headless sessions have no local physical window -> fill browser screen!
  if (sess.headless && !isMobileViewport()) return "fit-local";
  if (sess.headless && isMobileViewport()) return "fit-local";
  return "follow-host";
}

function updateSizeModeUI(): void {
  const isFollow = sizeMode === "follow-host";
  btnSizeMode.textContent = isFollow ? "[ 跟随主机 ]" : "[ 适配本机 ]";
  btnSizeMode.classList.toggle("active", !isFollow);
  termContainerEl.classList.toggle("follow-host", isFollow);
  applyTerminalSize();
}

function updateMobileBarUI(): void {
  mobileBarEl.classList.toggle("hidden", !mobileBarVisible);
  btnMobileBar.classList.toggle("active", mobileBarVisible);
  setTimeout(applyTerminalSize, 30);
}

function applyTerminalSize(): void {
  const sess = findSession(activeSessionId);
  const entry = getActiveSessionTerm();
  if (!sess || !entry) return;
  const { term, fitAddon } = entry;
  if (sizeMode === "follow-host") {
    if (term.cols !== sess.cols || term.rows !== sess.rows) {
      term.resize(sess.cols, sess.rows);
    }
  } else {
    try {
      fitAddon.fit();
      if (term.cols >= 20 && term.rows >= 5) {
        sendControl({
          type: "term.resize",
          sessionId: sess.sessionId,
          cols: term.cols,
          rows: term.rows,
        });
      }
    } catch {
      // container hidden or not ready
    }
  }
}

function closeMobileSidebar(): void {
  sidebarEl.classList.remove("mobile-open");
  backdropEl.classList.add("hidden");
}

function attachSession(sessionId: string): void {
  if (activeSessionId === sessionId) {
    closeMobileSidebar();
    return;
  }
  if (activeSessionId) {
    const prevEntry = sessionTerms.get(activeSessionId);
    if (prevEntry) {
      disableWebglFor(prevEntry);
      prevEntry.pane.classList.add("hidden");
    }
    sendControl({ type: "web.detach", sessionId: activeSessionId });
  }
  activeSessionId = sessionId;
  initialHashSessionId = null;
  history.replaceState(null, "", `#${encodeURIComponent(sessionId)}`);

  const entry = getOrCreateSessionTerm(sessionId);
  emptyStateEl.classList.add("hidden");
  termContainerEl.classList.remove("hidden");
  entry.pane.classList.remove("hidden");
  enableWebglFor(entry);
  entry.term.refresh(0, entry.term.rows - 1);

  const sess = findSession(sessionId);
  if (sess) {
    lastHostSizes.set(sess.sessionId, { cols: sess.cols, rows: sess.rows });
    sizeMode = resolveSizeModeFor(sess);
    activeTitleEl.textContent = `${sess.hostName} :: ${sess.title}`;
    updateSizeModeUI();
  }
  updateDocumentTitle();
  sendControl({
    type: "web.attach",
    sessionId,
    sinceSeq: entry.lastSeq ?? undefined,
  });
  renderHostList();
  closeMobileSidebar();
  if (!isMobileViewport()) {
    entry.term.focus();
  }
}

function startRenameSession(s: SessionInfo): void {
  const next = window.prompt("重命名终端标签：", s.title || s.shell);
  if (next && next.trim() && next.trim() !== s.title) {
    sendControl({ type: "term.rename", sessionId: s.sessionId, title: next.trim() });
  }
}

const AGENT_STATE_LABEL: Record<string, string> = {
  running: "运行中",
  tool: "运行中",
  waiting: "等待输入",
  idle: "空闲",
};

function formatAgentText(s: SessionInfo): string | null {
  if (!s.agentName || !s.agentState) return null;
  return AGENT_STATE_LABEL[s.agentState] ?? s.agentState;
}

function renderHostList(): void {
  hostListEl.innerHTML = "";
  let total = 0;

  for (const host of hosts) {
    total += host.sessions.length;
    const groupEl = document.createElement("div");
    groupEl.className = "host-group";

    const headerEl = document.createElement("div");
    headerEl.className = "host-header";

    const metaEl = document.createElement("div");
    metaEl.className = "host-meta";

    const nameEl = document.createElement("span");
    nameEl.className = "host-name";
    nameEl.textContent = host.hostName;

    const platEl = document.createElement("span");
    platEl.className = "host-platform";
    platEl.textContent = host.platform === "win32" ? "WIN" : host.platform.toUpperCase();

    metaEl.append(nameEl, platEl);

    const spawnBtn = document.createElement("button");
    spawnBtn.className = "spawn-btn";
    spawnBtn.textContent = "+";
    spawnBtn.title = `在 ${host.hostName} 上新建原生终端标签页`;
    spawnBtn.onclick = (e) => {
      e.stopPropagation();
      pendingSpawnHostId = host.hostId;
      pendingSpawnKnownIds = new Set(host.sessions.map((s) => s.sessionId));
      sendControl({ type: "host.spawn", hostId: host.hostId });
      showToast(`正在 ${host.hostName} 新建终端…`);
    };

    headerEl.append(metaEl, spawnBtn);
    groupEl.append(headerEl);

    const titleCounts = new Map<string, number>();
    for (const s of host.sessions) {
      const baseTitle = s.title || s.shell;
      const seen = (titleCounts.get(baseTitle) ?? 0) + 1;
      titleCounts.set(baseTitle, seen);
      const displayTitle = seen > 1 && !s.customTitle ? `${baseTitle} #${seen}` : baseTitle;

      const itemEl = document.createElement("div");
      itemEl.className = "session-item" + (s.sessionId === activeSessionId ? " active" : "");
      itemEl.onclick = () => attachSession(s.sessionId);
      itemEl.ondblclick = (e) => {
        e.stopPropagation();
        startRenameSession(s);
      };

      const infoEl = document.createElement("div");
      infoEl.className = "session-info";

      const titleEl = document.createElement("div");
      titleEl.className = "session-title";
      const dotEl = document.createElement("span");
      dotEl.className = "session-dot";
      const titleTextEl = document.createElement("span");
      titleTextEl.textContent = displayTitle;
      titleEl.append(dotEl, titleTextEl);

      const subEl = document.createElement("div");
      const agentText = formatAgentText(s);
      if (agentText && s.agentState) {
        subEl.className = `session-sub agent-status state-${s.agentState}`;
        subEl.textContent = agentText;
      } else {
        subEl.className = "session-sub";
        subEl.textContent = s.shell;
      }

      infoEl.append(titleEl, subEl);

      const actionsEl = document.createElement("div");
      actionsEl.className = "session-actions";

      const renameBtn = document.createElement("button");
      renameBtn.className = "action-btn";
      renameBtn.textContent = "✎";
      renameBtn.title = "重命名（也可双击标签）";
      renameBtn.onclick = (e) => {
        e.stopPropagation();
        startRenameSession(s);
      };

      const closeBtn = document.createElement("button");
      closeBtn.className = "close-btn";
      closeBtn.textContent = "×";
      closeBtn.title = "关闭该终端";
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`确定关闭 ${host.hostName} 上的「${displayTitle}」吗？`)) {
          sendControl({ type: "term.close", sessionId: s.sessionId });
        }
      };

      actionsEl.append(renameBtn, closeBtn);
      itemEl.append(infoEl, actionsEl);
      groupEl.append(itemEl);
    }

    hostListEl.append(groupEl);
  }

  sessionCountEl.textContent = String(total);

  const current = findSession(activeSessionId);
  if (current) {
    const agentBadge = formatAgentText(current);
    activeTitleEl.textContent = agentBadge
      ? `${current.hostName} :: ${current.title} [${agentBadge}]`
      : `${current.hostName} :: ${current.title}`;

    // Last-resizer-wins sync: if the host PTY size changed to something different from
    // our current xterm size (e.g. user resized the local PowerShell window), immediately
    // switch to follow-host so Web and host stay 100% aligned with zero desync.
    const prevHost = lastHostSizes.get(current.sessionId);
    const activeEntry = getActiveSessionTerm();
    const hostChanged =
      prevHost !== undefined && (prevHost.cols !== current.cols || prevHost.rows !== current.rows);
    lastHostSizes.set(current.sessionId, { cols: current.cols, rows: current.rows });

    if (
      hostChanged &&
      activeEntry &&
      (activeEntry.term.cols !== current.cols || activeEntry.term.rows !== current.rows)
    ) {
      sizeModeOverrides.set(current.sessionId, "follow-host");
      sizeMode = "follow-host";
      updateSizeModeUI();
    } else {
      const desired = resolveSizeModeFor(current);
      if (desired !== sizeMode) {
        sizeMode = desired;
        updateSizeModeUI();
      } else if (sizeMode === "follow-host") {
        applyTerminalSize();
      }
    }
  } else {
    activeSessionId = null;
    if (total > 0) {
      const allSessions = hosts.flatMap((h) => h.sessions);
      const hashTarget = initialHashSessionId
        ? allSessions.find((s) => s.sessionId === initialHashSessionId)
        : undefined;
      const target = hashTarget ?? allSessions[0];
      if (target) attachSession(target.sessionId);
    } else {
      activeTitleEl.textContent = "NO ACTIVE SESSION";
      termContainerEl.classList.add("hidden");
      emptyStateEl.classList.remove("hidden");
      updateDocumentTitle();
    }
  }
}

function setConnStatus(state: "connecting" | "online" | "offline"): void {
  connDotEl.className = "brand-dot " + (state === "online" ? "online" : state === "offline" ? "offline" : "");
  connLabelEl.textContent =
    state === "online" ? "LIVE" : state === "offline" ? "RETRY" : "SYNC";
}

function connect(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  setConnStatus("connecting");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}/ws/web`);
  socket.binaryType = "arraybuffer";
  ws = socket;

  socket.onopen = () => {
    setConnStatus("online");
    needsReattach = true;
    if (authToken) {
      sendControl({ type: "web.auth", token: authToken });
    }
  };

  socket.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      const frame = decodeBinaryFrame(new Uint8Array(ev.data));
      if (!frame) return;
      const entry = sessionTerms.get(frame.sessionId);
      if (!entry) return;
      if (frame.frameType === FRAME_PTY_REPLAY) {
        entry.decoder = new TextDecoder();
        entry.term.reset();
        entry.term.write(entry.decoder.decode(frame.payload, { stream: true }));
      } else if (frame.frameType === FRAME_PTY_OUTPUT) {
        entry.term.write(entry.decoder.decode(frame.payload, { stream: true }));
        if (entry.lastSeq !== null) {
          entry.lastSeq += frame.payload.length;
        }
      }
      return;
    }

    let msg: ControlMessage;
    try {
      msg = JSON.parse(String(ev.data)) as ControlMessage;
    } catch {
      return;
    }

    if (msg.type === "web.sync") {
      const entry = sessionTerms.get(msg.sessionId);
      if (entry) {
        entry.lastSeq = msg.seq;
      }
      return;
    }

    if (msg.type === "web.auth_ok") {
      authModalEl.classList.add("hidden");
      authErrorEl.textContent = "";
      if (msg.bootId) {
        if (relayBootId && relayBootId !== msg.bootId) {
          // Relay restarted: invalidate cached byte offsets so reattach triggers a clean full replay
          for (const entry of sessionTerms.values()) {
            entry.lastSeq = null;
          }
        }
        relayBootId = msg.bootId;
      }
      return;
    }

    if (msg.type === "web.auth_err") {
      authModalEl.classList.remove("hidden");
      authErrorEl.textContent = msg.message;
      return;
    }

    if (msg.type === "web.list") {
      hosts = msg.hosts;

      // Dispose xterm instances for sessions that have closed
      const validIds = new Set<string>();
      const nextStates = new Map<string, string>();
      for (const h of hosts) {
        for (const s of h.sessions) {
          validIds.add(s.sessionId);
          if (s.agentState) {
            nextStates.set(s.sessionId, s.agentState);
            const prev = prevAgentStates.get(s.sessionId);
            if (
              document.hidden &&
              (prev === "running" || prev === "tool") &&
              (s.agentState === "idle" || s.agentState === "waiting")
            ) {
              const label = s.agentState === "waiting" ? "等待输入" : "已完成";
              unreadTitleAlert = `● [${label}] ${s.title} — Rift`;
            }
          }
        }
      }
      disposeStaleSessionTerms(validIds);
      prevAgentStates.clear();
      for (const [k, v] of nextStates) prevAgentStates.set(k, v);

      // Auto-switch to a newly spawned `+` session on the target host
      let spawnedSessionId: string | null = null;
      if (pendingSpawnHostId) {
        const targetHost = hosts.find((h) => h.hostId === pendingSpawnHostId);
        const newSess = targetHost?.sessions.find((s) => !pendingSpawnKnownIds.has(s.sessionId));
        if (newSess) {
          spawnedSessionId = newSess.sessionId;
          pendingSpawnHostId = null;
          pendingSpawnKnownIds.clear();
        }
      }

      const prevActive = activeSessionId;
      renderHostList();
      if (spawnedSessionId) {
        needsReattach = false;
        attachSession(spawnedSessionId);
      } else if (needsReattach && prevActive && findSession(prevActive)) {
        needsReattach = false;
        const entry = sessionTerms.get(prevActive);
        sendControl({
          type: "web.attach",
          sessionId: prevActive,
          sinceSeq: entry?.lastSeq ?? undefined,
        });
      } else {
        needsReattach = false;
      }
      updateDocumentTitle();
    }
  };

  socket.onclose = () => {
    setConnStatus("offline");
    if (ws === socket) ws = null;
    reconnectTimer = window.setTimeout(connect, 1500);
  };

  socket.onerror = () => {
    socket.close();
  };
}

// UI event listeners
btnSidebar.onclick = () => {
  if (isMobileViewport()) {
    const open = sidebarEl.classList.toggle("mobile-open");
    backdropEl.classList.toggle("hidden", !open);
  } else {
    sidebarEl.classList.toggle("collapsed");
    setTimeout(applyTerminalSize, 200);
  }
};

backdropEl.onclick = closeMobileSidebar;

btnSizeMode.onclick = () => {
  sizeMode = sizeMode === "follow-host" ? "fit-local" : "follow-host";
  if (activeSessionId) {
    sizeModeOverrides.set(activeSessionId, sizeMode);
  }
  updateSizeModeUI();
};

btnMobileBar.onclick = () => {
  mobileBarVisible = !mobileBarVisible;
  updateMobileBarUI();
};

btnTheme.onclick = () => {
  themeName = themeName === "ember" ? "phosphor" : "ember";
  applyTheme();
};

const QUICK_KEY_MAP: Record<string, string> = {
  esc: "\x1b",
  tab: "\t",
  "ctrl-c": "\x03",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  enter: "\r",
  clear: "\x0c",
};

document.querySelectorAll<HTMLButtonElement>(".qkey").forEach((btn) => {
  const key = btn.dataset.key;
  if (!key) return;
  btn.onclick = () => {
    const seq = QUICK_KEY_MAP[key];
    if (seq) sendTerminalInput(seq);
  };
});

if (btnPickImage && imageFileInput) {
  btnPickImage.onclick = () => imageFileInput.click();
  imageFileInput.onchange = () => {
    const file = imageFileInput.files?.[0];
    if (file) {
      uploadPastedImage(file);
    }
    imageFileInput.value = "";
  };
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    updateDocumentTitle();
  }
});

composerForm.onsubmit = (e) => {
  e.preventDefault();
  const text = composerInput.value;
  if (!text) {
    sendTerminalInput("\r");
    return;
  }
  sendTerminalInput(text + "\r");
  composerInput.value = "";
};

authFormEl.onsubmit = (e) => {
  e.preventDefault();
  authToken = authInputEl.value.trim();
  localStorage.setItem("rift_token", authToken);
  sendControl({ type: "web.auth", token: authToken });
};

window.addEventListener("resize", () => {
  if (sizeMode === "fit-local") {
    applyTerminalSize();
  }
});

// If relay requires auth, show modal when no auth_ok arrives shortly after open
fetch("/health")
  .then((r) => r.json())
  .then((info: { authRequired?: boolean }) => {
    if (info.authRequired && !authToken) {
      authModalEl.classList.remove("hidden");
    }
  })
  .catch(() => {});

applyTheme();
updateSizeModeUI();
updateMobileBarUI();
connect();
