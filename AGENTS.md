# Rift 工程入口（Agent 路由）

> 极薄跨平台终端镜像：Rust 单文件客户端 + Node 纯内存中转 + xterm.js 网页端。
> 本文件只做路由与红线指针；细节一律下沉，勿在此堆积。

## 路由链（按序加载）
1. **本文件**：工作区地图、验证命令、红线指针。
2. **`docs/SPEC.md`**：唯一全局活文档——三条红线、协议不变量表、活跃取舍、已验证边界。改红线/协议/边界须同一轮原地更新它，不建并行设计文档。
3. **源码就近 `Why` 注释**：反直觉上限、顺序约束、不变量的原因。
4. **`pre-pr-check` 技能**（`.qoder/skills/pre-pr-check/SKILL.md`）：高风险改动提交前清单与独立只读 Review 手册。

## 工作区地图
- `crates/rift/` — Rust CLI（`proxy`/`console`/`daemon`/`attach`/`setup`/`agent_hook`/`protocol`）。
- `packages/shared/` — TS 线协议与 `ByteRingBuffer`，须与 `crates/rift/src/protocol.rs` 同源。
- `packages/relay/` — 无状态纯内存 Node HTTP/WS 中转 + 静态网页托管。
- `packages/web/` — Vite + `@xterm/xterm` 网页终端（`terminal-utils.ts` 为纯函数 helper）。
- `packages/agent/` — Node 参考 agent（`node-pty`）。
- `scripts/` — 门禁与真机脚本；`tests/` — 三层测试（unit/boundary/architecture）。
- 搜索忽略产物：`crates/*/target/`、`packages/*/dist/`、`node_modules/`、`zellij.exe`。

## 验证命令（本地与 CI 同一套）
- 完整门禁：`npm run check`（预算→链接→边界→测试模式→卫生→协议同源→typecheck→build→cargo check→三层测试→cargo test→浏览器冒烟→spec 提醒）。CI 跑完全相同命令。
- 快速迭代：`npm run check:quick`（无 cargo，约 10s）；文档同步：`npm run check:docs`。
- 分层测试：`npm run test:unit` / `test:boundary`（真实 spawn relay + WS）/ `test:arch`（门禁反例自测）/ `test:rust`。
- 真机实二进制（手动）：`cargo build --release --manifest-path crates/rift/Cargo.toml` 后 `npm run test:win-keys`（Windows）与 `npm run test:e2e`。

## 红线（细节见 docs/SPEC.md，不在此重复）
1. **SPEC 三红线**：零重型业务编排、本地 100% 原生无感、单文件零依赖客户端——见 `docs/SPEC.md` §1。
2. **协议同源**：TS `packages/shared` 与 Rust `protocol.rs` 的帧常量/变体/字段禁单边漂移（`check:protocol` 钉住）。
3. **无兼容债**：不留死 shim、无用分支、真空 catch；仅含注释的 best-effort catch 合法。
4. **测试钉真实边界 + BugTDD**：每个真 Bug 修复在最便宜层加可证伪回归（unit > 静态门禁 > boundary/E2E），并验证撤掉修复会红、恢复转绿。
5. **Why-only 注释**：只写非显而易见的原因，不写复述代码的废话。
6. **活文档预算**：常驻文档受 `check:budgets` 约束（见下）。
7. **高风险只读 Review**：触及协议/PTY/重连/钩子时按 `pre-pr-check` 技能拉独立只读 Review，过 SPEC 不变量 + 传统缺陷双尺。
8. **止损与 Git 安全**：同一问题 3 次失败即停手换思路；危险命令由 `.qoder/settings.json` 钩子 fail-closed 拦截；未经用户明确要求严禁 `git commit`/`git push`。

## 预算维护
- 上限见 `scripts/doc-budgets.manifest.json`（AGENTS.md 与 docs/SPEC.md）。超限先**下沉**细节到源码/技能，再**压缩**措辞，确有理由才调上限并说明。
- 准入：同一约定若在两个会话反复被遗忘，应沉淀为门禁或本文件一行红线，而非口头重复。

## 诚实汇报
**未经最后一次改动后实跑 `npm run check`，严禁宣称通过。** 只汇报实际跑过的命令与精确通过数，并标明未覆盖的真机验证范围。提交消息解释 **Why**，而非罗列文件。保持克制：不引重型依赖（`node:test` 够用就不上测试框架），守住 `rift` 极薄。
