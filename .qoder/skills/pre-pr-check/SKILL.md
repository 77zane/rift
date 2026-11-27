---
name: pre-pr-check
description: Rift 高风险改动（协议同源、PTY/ConPTY 生命周期、relay 重连/宽限状态机、渲染或安全钩子）的提交前验证清单与独立只读 Review 操作手册。准备提交 PR 或完成此类改动前按需加载。
---

# 提交前核对与独立只读 Review 手册

在准备提交 PR 或完成高风险改动前按需加载执行。普通小改跳过第 3 节。

## 1. 最后一次改动后跑完确定性门禁

在仓库根目录运行 `npm run check`（与 CI 完全同一命令），确认所有阻塞门禁全部通过。若在跑完后又改了任何文件，必须重新执行，严禁拿旧结果汇报通过。

若 `check:spec` 输出 `WARN`（核心行为/协议文件已改但 `docs/SPEC.md` 未同步）：
- 若改动影响了红线、协议不变量或已验证边界，在同一轮原地更新 `docs/SPEC.md`；
- 若确属纯内部重构且契约未变，在交付说明里明确写出依据。

快速迭代可用 `npm run check:quick`（无 cargo，约 10s）；交付前仍须跑完整 `npm run check`。

## 2. Bug 修复防复发三件套核对

每一次真实 Bug 修复，确认同一轮沉淀进三件活资产（不写只写不读的历史复盘）：
1. **活文档**：若暴露了缺失的不变量或红线，已原地补进 `docs/SPEC.md`（§2 不变量表或 §4 已验证边界）；
2. **就近 `Why` 注释**：涉及反直觉数值上限、顺序约束或不变量时，已在源码正上方补 1 行原因注释；
3. **可证伪红灯门禁**：新增回归测试钉在能观测到该 Bug 的最便宜层（unit > 静态门禁 > boundary/E2E）。relay 装配出口类 Bug 优先 `tests/boundary/`（真实 spawn relay + WS），而非孤立 `ByteRingBuffer` 单测。已验证去掉修复时测试确实报红、恢复修复后转绿。若新增或改动了 `scripts/` 门禁或 Hook，同步在 `tests/architecture/` 补反例自测。

## 3. 独立只读 Review（仅高风险改动触发）

当 diff 触及以下任一面时触发；普通小改直接跳过：
- `docs/SPEC.md`、`packages/shared/src/index.ts` ↔ `crates/rift/src/protocol.rs`（协议同源）；
- `crates/rift/src/console.rs`、`proxy.rs`、`daemon.rs`、`agent_hook.rs`（PTY/ConPTY 生命周期）；
- `packages/relay/src/index.ts`（重连/宽限状态机、ring 回放、sinceSeq 增量）；
- `packages/web/src/terminal-utils.ts`、`vite.config.ts`（渲染/构建目标）；
- `.qoder/settings.json`、`scripts/`（门禁与钩子）。

拉起**独立只读 Review 视角**（只读 subagent 或单独审 `git diff`），同时过两把尺子：

1. **SPEC 不变量视角**：
   - 是否违背 `docs/SPEC.md` §1 红线或 §2 不变量表（4MiB 无损回放、bootId 复位、宽限保留、customTitle 保护、协议字段同源）？
   - 是否存在“局部看似变快、实则静默削弱终端镜像体验”的破坏性优化（如偷偷截断回放尾部）？
2. **传统工程缺陷视角**：
   - 边界输入校验是否遗漏（`NaN`、负数、带单位字符串、空载荷、超长 sessionId）？
   - 是否存在资源泄漏（未清理 graceTimer、监听器、子进程、WS）或并发竞态（重注册 vs 宽限到期）？
   - 跨平台路径（Windows ConPTY / POSIX）处理与测试断言是否存在假阳性？
   - 是否悄悄留下了无用兼容垫片、死分支或真空 `catch`（仅含注释的 best-effort catch 合法）？

## 4. 如实汇报

只汇报本次实际运行过的命令、精确通过数，以及未在自动化门禁中覆盖的真环境验证范围（真实 Windows Terminal 键位/贴图手感、移动弱网/虚拟键盘、macOS/Linux 实体终端、Qoder 钩子真机拦截）。
