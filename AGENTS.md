# Rift Agent Guide

> Ultra-thin cross-platform terminal mirror: Rust single-binary client + Node memory relay + xterm.js web UI.

## Workspace Map
- `crates/rift/` — Rust CLI (`proxy`, `console`, `daemon`, `attach`, `setup`, `agent_hook`, `protocol`)
- `packages/shared/` — TS wire protocol & `ByteRingBuffer` (must stay synced with `crates/rift/src/protocol.rs`)
- `packages/relay/` — Stateless in-memory Node HTTP/WS relay + static web hosting
- `packages/web/` — Vite + `@xterm/xterm` web terminal (`terminal-utils.ts` holds pure testable helpers)
- `packages/agent/` — Node reference agent (`node-pty`)
- `scripts/` — Static gates (`check-protocol-sync`, `check-spec-touch`), `browser-smoke`, `win-conpty-keys`, `e2e-verify`
- Ignore generated/vendor artifacts when searching: `crates/*/target/`, `packages/*/dist/`, `node_modules/`, `zellij.exe`

## Living Spec
- Read `docs/SPEC.md` for architecture red lines, protocol invariants, active trade-offs, and verified boundaries.
- Update `docs/SPEC.md` incrementally in the same change whenever red lines, protocol contracts, or verified boundaries shift.

## Verification Commands
- Full local gate: `npm run check` (typecheck → build → protocol sync → TS/Rust unit tests → headless browser smoke → spec touch reminder)
- Unit tests only: `npm test` (`node --test` + `cargo test`)
- Real binary E2E: `cargo build --release --manifest-path crates/rift/Cargo.toml` then `npm run test:e2e` and `npm run test:win-keys` (Windows)

## Working Rhythm
1. **Incremental Living Spec**: Keep `docs/SPEC.md` truthful and compact. Do not create parallel design docs or bloated templates.
2. **TDD + BugTDD (with spike exception)**:
   - For clear logic/protocol/helper changes, write a failing test first, then implement.
   - Every real bug fix **must** add a permanent regression test at the cheapest layer that catches it (unit > static gate > browser/E2E).
   - Pure UI/hardware spikes may prototype first, but must add regression coverage before finishing.
3. **On-Demand Subagent Review**: For changes touching wire protocol, Rust/TS boundary, PTY/ConPTY lifecycle, or reconnect state machines, run an incremental read-only review checking both `docs/SPEC.md` invariants and classic failure modes (resource leaks, cross-platform edge cases, swallowed errors). Skip ceremony for trivial edits.

## Collaboration
- Never `git commit` or `git push` unless the user explicitly asks.
- Commit messages explain **Why**, not just file lists.
- Stay restrained: avoid heavy dependencies (e.g., Playwright, test runners when `node:test` suffices) and keep `rift` minimal.
