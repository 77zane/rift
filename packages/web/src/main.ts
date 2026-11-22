import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
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

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let ws: WebSocket | null = null;
let hosts: HostGroup[] = [];
let activeSessionId: string | null = null;
// Always default to "follow-host" so opening a browser NEVER squishes the local Windows Terminal PTY width.
let sizeMode: "follow-host" | "fit-local" = "follow-host";
let mobileBarVisible = isMobileViewport();
let reconnectTimer: number | null = null;
let needsReattach = false;
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

const term = new Terminal({
  cursorBlink: true,
  fontSize: isMobileViewport() ? 12 : 14,
  fontFamily: '"JetBrains Mono", "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace',
  scrollback: 5000,
  theme: XTERM_THEMES[themeName],
});

function applyTheme(): void {
  document.documentElement.dataset.theme = themeName;
  btnTheme.textContent = themeName === "ember" ? "EMBER" : "PHOSPHOR";
  term.options.theme = XTERM_THEMES[themeName];
  localStorage.setItem("rift_theme", themeName);
}

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon());
term.open(termContainerEl);

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

term.onData((data) => {
  sendTerminalInput(data);
});

// Enable native paste & voice-IME dictation (Typeless, Wispr Flow, Windows Voice Typing, etc.):
// By default on Windows/Linux, xterm.js swallows Ctrl+V as raw ^V (\x16) instead of triggering browser paste.
term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
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

// Single unified paste handler (capture phase) for clipboard paste & voice-IME dictation (Typeless, etc.):
// 1. Prevents double-injection;
// 2. Strips trailing newlines so dictation NEVER auto-submits with Enter;
// 3. Uses atomic Bracketed Paste when supported, or collapses internal newlines to spaces when not,
//    preventing multi-paragraph dictation from splitting and accidentally triggering Enter mid-message.
window.addEventListener(
  "paste",
  (ev: ClipboardEvent) => {
    const target = ev.target as HTMLElement | null;
    if (
      target &&
      (target === composerInput ||
        target === authInputEl ||
        (target.tagName === "INPUT" && target !== term.textarea) ||
        (target.tagName === "TEXTAREA" && target !== term.textarea))
    ) {
      return;
    }

    const raw = ev.clipboardData?.getData("text/plain");
    if (!raw || !activeSessionId) return;

    ev.preventDefault();
    ev.stopImmediatePropagation();

    // Never auto-submit on trailing CR/LF
    const trimmedEnd = raw.replace(/[\r\n]+$/, "");
    if (!trimmedEnd) return;

    if (term.modes.bracketedPasteMode) {
      const normalized = trimmedEnd.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      sendTerminalInput(`\x1b[200~${normalized}\x1b[201~`);
    } else {
      // Without bracketed paste, any CR/LF acts as Enter and submits immediately.
      const singleLine = trimmedEnd.replace(/[\r\n]+/g, " ");
      sendTerminalInput(singleLine);
    }
    term.focus();
  },
  { capture: true }
);

function findSession(id: string | null): SessionInfo | null {
  if (!id) return null;
  for (const h of hosts) {
    for (const s of h.sessions) {
      if (s.sessionId === id) return s;
    }
  }
  return null;
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
  if (!sess) return;
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
    sendControl({ type: "web.detach", sessionId: activeSessionId });
  }
  activeSessionId = sessionId;
  term.reset();
  emptyStateEl.classList.add("hidden");
  termContainerEl.classList.remove("hidden");

  const sess = findSession(sessionId);
  if (sess) {
    activeTitleEl.textContent = `${sess.hostName} / ${sess.title}`;
    applyTerminalSize();
  }
  sendControl({ type: "web.attach", sessionId });
  renderHostList();
  closeMobileSidebar();
  if (!isMobileViewport()) {
    term.focus();
  }
}

const AGENT_STATE_LABEL: Record<string, string> = {
  running: "思考中",
  tool: "执行工具",
  waiting: "待确认",
  idle: "空闲",
};

function formatAgentText(s: SessionInfo): string | null {
  if (!s.agentName || !s.agentState) return null;
  const label = AGENT_STATE_LABEL[s.agentState] ?? s.agentState;
  return `${s.agentName.toUpperCase()} · ${label}`;
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
      sendControl({ type: "host.spawn", hostId: host.hostId });
    };

    headerEl.append(metaEl, spawnBtn);
    groupEl.append(headerEl);

    for (const s of host.sessions) {
      const itemEl = document.createElement("div");
      itemEl.className = "session-item" + (s.sessionId === activeSessionId ? " active" : "");
      itemEl.onclick = () => attachSession(s.sessionId);

      const infoEl = document.createElement("div");
      infoEl.className = "session-info";

      const titleEl = document.createElement("div");
      titleEl.className = "session-title";
      const dotEl = document.createElement("span");
      dotEl.className = "session-dot";
      const titleTextEl = document.createElement("span");
      titleTextEl.textContent = s.title || s.shell;
      titleEl.append(dotEl, titleTextEl);

      const subEl = document.createElement("div");
      subEl.className = "session-sub";
      subEl.textContent = `${s.shell} · ${s.cols}×${s.rows}`;

      infoEl.append(titleEl, subEl);

      const agentText = formatAgentText(s);
      if (agentText && s.agentState) {
        const badgeEl = document.createElement("div");
        badgeEl.className = `agent-badge state-${s.agentState}`;
        const bDot = document.createElement("span");
        bDot.className = "agent-badge-dot";
        const bText = document.createElement("span");
        bText.textContent = agentText;
        badgeEl.append(bDot, bText);
        infoEl.append(badgeEl);
      }

      const closeBtn = document.createElement("button");
      closeBtn.className = "close-btn";
      closeBtn.textContent = "×";
      closeBtn.title = "关闭该终端";
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`确定关闭 ${host.hostName} 上的「${s.title}」吗？`)) {
          sendControl({ type: "term.close", sessionId: s.sessionId });
        }
      };

      itemEl.append(infoEl, closeBtn);
      groupEl.append(itemEl);
    }

    hostListEl.append(groupEl);
  }

  sessionCountEl.textContent = String(total);

  const current = findSession(activeSessionId);
  if (current) {
    const agentBadge = formatAgentText(current);
    activeTitleEl.textContent = agentBadge
      ? `${current.hostName} :: ${current.title} [${agentBadge}] · ${current.cols}×${current.rows}`
      : `${current.hostName} :: ${current.title} · ${current.cols}×${current.rows}`;
    if (sizeMode === "follow-host") {
      applyTerminalSize();
    }
  } else {
    activeSessionId = null;
    if (total > 0) {
      const firstSession = hosts.flatMap((h) => h.sessions)[0];
      if (firstSession) attachSession(firstSession.sessionId);
    } else {
      activeTitleEl.textContent = "NO ACTIVE SESSION";
      termContainerEl.classList.add("hidden");
      emptyStateEl.classList.remove("hidden");
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
      if (!frame || frame.sessionId !== activeSessionId) return;
      if (frame.frameType === FRAME_PTY_REPLAY) {
        term.reset();
        term.write(textDecoder.decode(frame.payload));
      } else if (frame.frameType === FRAME_PTY_OUTPUT) {
        term.write(textDecoder.decode(frame.payload));
      }
      return;
    }

    let msg: ControlMessage;
    try {
      msg = JSON.parse(String(ev.data)) as ControlMessage;
    } catch {
      return;
    }

    if (msg.type === "web.auth_ok") {
      authModalEl.classList.add("hidden");
      authErrorEl.textContent = "";
      return;
    }

    if (msg.type === "web.auth_err") {
      authModalEl.classList.remove("hidden");
      authErrorEl.textContent = msg.message;
      return;
    }

    if (msg.type === "web.list") {
      hosts = msg.hosts;
      const prevActive = activeSessionId;
      renderHostList();
      if (needsReattach && prevActive && findSession(prevActive)) {
        needsReattach = false;
        sendControl({ type: "web.attach", sessionId: prevActive });
      } else {
        needsReattach = false;
      }
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
  btn.onclick = () => {
    const key = btn.dataset.key;
    const seq = key ? QUICK_KEY_MAP[key] : undefined;
    if (seq) sendTerminalInput(seq);
  };
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
