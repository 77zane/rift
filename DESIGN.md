# Rift — 极简多机终端同屏网关设计方案

> 定位：**撕开一道极薄的终端空间裂隙**——本地 Windows Terminal / PowerShell / CMD / Linux Shell 照常原生使用，远程电脑或手机浏览器实时双向同屏操控，多台主机 A 汇聚到一台自建公网中转服务器 C 统一切换。

---

## 一、设计原则（三条红线）

1. **零重型业务编排**：不做任务数据库、不做 Git Worktree 管理、不做 AI CLI 适配层、不解析聊天记录；不管终端里跑的是 `agy`、`claude`、`pwsh` 还是 `bash`，一律当原生 PTY 透明透传。
2. **本地 100% 原生无感**：不套复用器边框/快捷键层，不改 Windows Terminal 源码；通过 `rift hook install` 一次性绑定后，平时照常开终端即自动上云，环境变量完整继承。
3. **单文件零依赖客户端**：客户端 `rift` 用 **Rust** 编译为跨平台单文件二进制（Windows ConPTY / Linux & macOS Unix PTY），无需目标机安装 Node.js。

---

## 二、总体架构

```text
  本地主机 A1（Windows Terminal / PowerShell / CMD）       其他主机 A2/A3（Linux / macOS / 另一台 Win）
   ├── rift.exe（Rust 单文件透明 PTY 代理，零 Node 依赖）     ├── rift（Rust 单文件）
   │    ├── 本地：stdin/stdout Raw 直通，原生体验零变化       └── rift daemon（常驻保活）
   │    ├── 缓冲：本地 256KB Ring Buffer（重连秒恢复）
   │    └── 旁路：主动 wss:// 反向连中转 C（断线自动重连）
   └── rift daemon（可选常驻，0 会话也保持主机在线可点 `+`）
                        │                                          │
                        └────────────────────┬─────────────────────┘
                                             ▼
                        中转服务器 C（公网 Linux VPS + Nginx HTTPS）
                         ├── @rift/relay（纯内存 WS 路由 + 鉴权，无数据库）
                         └── 托管极简 Web 静态页（@rift/web · xterm.js）
                                             │
                                             ▼
                        远程端 B（手机 4G/5G / 另一台电脑浏览器）
                         ├── 左侧栏：按主机分组（A1 / A2 / A3）切换标签 + 点 `+` 远程新建
                         ├── 主区域：xterm.js 真彩色终端（EMBER 暖炭 / PHOSPHOR 磷光绿双主题）
                         └── 手机端：实体键帽快捷栏 + 中文独立发送框 + 「跟随主机」防挤乱开关
```

---

## 三、技术栈与目录结构

| 模块 | 选型 | 路径 |
| :--- | :--- | :--- |
| ─── | ─── | ─── |
| **本地单文件客户端 (`rift`)** | **Rust**（`portable-pty` + `tokio-tungstenite` + `crossterm` + `clap`） | [crates/rift](file:///C:/Users/7/workspace/agentshare/crates/rift) |
| ─── | ─── | ─── |
| **共享协议 (`@rift/shared`)** | TypeScript（二进制帧编解码 + 控制消息类型 + RingBuffer） | [packages/shared](file:///C:/Users/7/workspace/agentshare/packages/shared) |
| ─── | ─── | ─── |
| **中转网关 (`@rift/relay`)** | Node.js 原生 `http` + `ws`（纯内存路由 + 静态托管 + 双密钥鉴权） | [packages/relay](file:///C:/Users/7/workspace/agentshare/packages/relay) |
| ─── | ─── | ─── |
| **极简前端 (`@rift/web`)** | Vite + TypeScript + `@xterm/xterm`（`EMBER` / `PHOSPHOR` 双主题） | [packages/web](file:///C:/Users/7/workspace/agentshare/packages/web) |

---

## 四、CLI 命令设计（Rust `rift`）

- `rift init --relay <url> --host <name> --token <token>`：写入 `~/.rift/config.json`
- `rift [-- <shell>]`：读配置启动透明 PTY 双向同屏代理
- `rift daemon`：极轻后台主机保活（0 会话时仍允许手机点 `+` 远程拉起终端）
- `rift attach [sessionId]`：在本地终端无缝接管手机 `+` 出来的后台会话，`Ctrl+]` 脱离
- `rift hook install / uninstall`：一键安装/移除自动接入钩子（内置 `RIFT_SESSION_ID` 防套娃）

---

## 五、分阶段进度

| 阶段 | 状态 | 核心交付 |
| :--- | :--- | :--- |
| ─── | ─── | ─── |
| **Phase 1：本地闭环 MVP** | ✅ 已完成 | 协议 + 中转 + 代理 + 前端闭环跑通并 E2E 验证 |
| ─── | ─── | ─── |
| **Phase 2：多机 + 手机体验 + Rust 单文件化** | ✅ 进行中 / 验证 | `Rift` 品牌统一、`EMBER`/`PHOSPHOR` 双主题、Rust 单文件客户端（含 `init` / `daemon` / `attach` / `hook`） |
| ─── | ─── | ─── |
| **Phase 3：安全加固与阿里云正式部署** | ⏸️ 待启动 | 阿里云 `systemd` 常驻部署 `relay` + Nginx 独立域名 + 防爆破限速 + 开源发布准备 |
