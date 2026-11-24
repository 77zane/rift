# Rift — Living Specification

> **定位**：撕开一道极薄的终端空间裂隙——本地原生终端照常使用，多台主机反向连到轻量纯内存中转服务，任意浏览器实时双向同屏操控。

---

## 1. 三条红线（不可违背）

1. **零重型业务编排**：不做任务数据库、Git Worktree 管理、AI 对话解析或权限拦截；终端里跑什么（`agy`/`claude`/`codex`/`pwsh`/`bash`），一律按原生 PTY 透明透传。
2. **本地 100% 原生无感**：不套复用器边框或劫持常用快捷键。
   - **Windows ConPTY 键位契约**：本地 `stdin` 必须启用 `ENABLE_VIRTUAL_TERMINAL_INPUT`（`crates/rift/src/console.rs`），退出时通过 RAII 精确恢复原 ConsoleMode；同时在 Windows 本地输出侧剥离 inbox `conhost.exe` 不支持的键盘协议升级请求（Kitty CSI-u、`modifyOtherKeys`、`win32-input-mode`），并在进入 ConPTY 的输入侧兜底翻译这三类序列，确保 `Esc`、`Ctrl+C`、方向键、`Home`/`End`、`Shift+Tab`、`Shift+Enter` 和中文 UTF-8 零丢失。
3. **单文件零依赖客户端**：`crates/rift` 编译为跨平台单文件二进制（~1.5–1.8 MB），不依赖目标机 Node.js，不引入重型运行时依赖。

---

## 2. 架构与核心不变量（Invariants）

| 领域 | 当前契约 / 不变量 | 锚点 |
| :--- | :--- | :--- |
| ─── | ─── | ─── |
| **TS ↔ Rust 协议同源** | `FRAME_PTY_OUTPUT`/`INPUT`/`REPLAY`、`ControlMessage` 全部变体及 `SessionInfo` 字段必须在 TS 与 Rust 两端完全一致，禁止单边漂移。 | `packages/shared/src/index.ts` ↔ `crates/rift/src/protocol.rs`（门禁 `npm run check:protocol`） |
| ─── | ─── | ─── |
| **无损回放缓冲** | Relay 侧默认 **4 MB** `ByteRingBuffer` + WS `permessage-deflate`；Rust 客户端侧 **2 MB** `ByteRingBuffer`。禁止回退到 256 KB 截断导致高频 TUI 历史丢失。 | `packages/shared/src/index.ts`, `crates/rift/src/proxy.rs` |
| ─── | ─── | ─── |
| **增量同步与重启复位** | Relay 启动生成随机 `RELAY_BOOT_ID`，在 `web.auth_ok` 下发 `bootId`；前端 `web.attach` 携带 `sinceSeq`，Relay 返回 `web.sync`。`bootId` 变更或 `ByteRingBuffer.replace()` 推进偏移后，前端必须清零 `lastSeq` 触发干净全量重放，禁止错位拼接。 | `packages/relay/src/index.ts`, `packages/web/src/terminal-utils.ts` |
| ─── | ─── | ─── |
| **断线宽限与进程脱离** | Agent 异常断线后 Relay 保留 **15s** 宽限期（`SESSION_GRACE_MS`），期间标 `reconnecting: true` 不误删会话；`host.spawn` 在 Windows 上脱离父 Job Object 启动，防止守护重启连带杀会话。 | `packages/relay/src/index.ts`, `crates/rift/src/daemon.rs` |
| ─── | ─── | ─── |
| **标签标题保护** | 用户手动重命名或 `--title` 锁定 `customTitle: true` 后，OSC 标题不得覆盖；默认过滤 `pwsh.exe`/`cmd.exe` 等通用 Shell 标题。 | `crates/rift/src/proxy.rs`, `packages/relay/src/index.ts` |
| ─── | ─── | ─── |
| **Web 终端渲染与输入** | `@xterm/xterm@6.0` + Vite `build.target: "es2022"`（严禁降级 `es2020` 破坏 `||=` 导致 `DECRQM` `\x1b[?2026$p` 运行时崩溃）；粘贴与语音输入法自动剥离末尾换行，防止误触回车提交。 | `packages/web/vite.config.ts`, `packages/web/src/terminal-utils.ts` |
| ─── | ─── | ─── |
| **AI Agent 只读钩子** | Claude `Notification` 必须限定 `matcher: "permission_prompt|elicitation_dialog"`（禁用 `"*"`）；`agent-hook` 识别 `idle_prompt -> idle`、`fullyIdle: false -> running`，且超时 ≤600ms 静默失败不阻塞 CLI。 | `crates/rift/src/setup.rs`, `crates/rift/src/agent_hook.rs` |

---

## 3. 活跃取舍（Trade-offs）

| 决策 | 选择 | 放弃 / 代价 |
| :--- | :--- | :--- |
| ─── | ─── | ─── |
| **Relay 状态存储** | 纯内存（无数据库），重启靠 Agent 断线重连推送 2MB 本地快照恢复 | 离线会话不持久化；换取零运维与低延迟 |
| ─── | ─── | ─── |
| **Windows ConPTY 键盘兼容** | 本地输出过滤 Kitty/MOK/win32-input-mode + 输入兜底翻译 | 不在 Windows 嵌套链路内透传 Kitty 扩展事件类型；保住 ~1.5MB 单文件且无需随包分发 `OpenConsole.exe` |
| ─── | ─── | ─── |
| **浏览器回归验证** | 零依赖本机 Chrome/Edge + CDP 冒烟脚本（`scripts/browser-smoke.mjs`） | 依赖运行机存在 Chrome/Edge（无浏览器环境默认跳过，可 `--require-browser` 强制）；避免引入数百 MB Playwright |
| ─── | ─── | ─── |
| **测试框架** | Node 内置 `node:test` + Rust `cargo test` | 不引入 Vitest/Jest 额外依赖树，保持启动极快 |

---

## 4. 已验证边界（Automated vs Manual）

### 自动化门禁覆盖
- **静态检查**：`npm run typecheck`、`npm run build`、`npm run check:protocol`（TS ↔ Rust 协议对齐）、`npm run check:spec`（活 Spec 非阻塞提醒）。
- **单测（`npm test`）**：
  - `@rift/shared`：二进制帧编解码、`ByteRingBuffer` >512KB 无损回放、`replace()` 偏移推进。
  - `@rift/web`：语音/多行粘贴防误提交、`bootId` 变更清游标、`headless` 尺寸模式策略。
  - `crates/rift`：Windows ConsoleMode 标志位、Kitty/MOK/win32-input-mode 输出过滤与输入翻译、`protocol` 编解码与 serde、`agent_hook` 状态修正、`setup` Claude 钩子 matcher、`config` WS URL 规范化、`proxy` base64 与 OSC 标题过滤。
- **真实集成回归**：
  - `npm run test:browser`：真实无头 Chrome/Edge 加载 Vite 生产包 `packages/web/dist/`，灌入 `DECRQM`（`\x1b[?2026$p`）+ DEC 2026 + Unicode `○`/中文，验证 0 JS 异常、输入往返、Relay 重启后 `bootId` 自动恢复。
  - `npm run test:win-keys`（Windows）：嵌套真实 `rift.exe` 于 ConPTY，验证 `Esc`/`Ctrl+C`/方向键/`Home`/`End`/`Shift+Tab`/中文全通且不泄漏 Kitty/MOK/win32-input-mode。
  - `npm run test:e2e`：真实 Relay + Rust `rift.exe` 全链路（鉴权、宽限重连、`customTitle` 保留、缩放、重命名、Agent 状态、安全关闭）。

### 需人工确认的边界
- 真实 Windows Terminal 实体窗口中直接运行 `agy` / `claude` 的键盘交互、剪贴板粘贴图片与窗口缩放手感。
- 手机 4G/5G 弱网切换及移动端虚拟键盘 / 语音输入法联调。
- macOS / Linux 实体终端（Ghostty / Alacritty / SSH）实机验证。
