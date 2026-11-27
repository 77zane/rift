/**
 * tests/architecture —— Rift 安全钩子反例自测。
 * 验证 Qoder PreToolUse 协议（deny=stderr+exit2 / allow=stdout+exit0）、fail-closed、
 * 非锚定 matcher 对 BashOutput/NotebookEdit 的放行，以及 Rift 专属必拦/必放行矩阵。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateToolAction, extractToolAction, splitCommandSegments } from '../../scripts/hooks/guard-tool.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const HOOK = join(ROOT, 'scripts/hooks/guard-tool.mjs');

/** 以子进程实跑钩子，返回 { status, stdout, stderr }。 */
function runHook(input, cwd = ROOT) {
  const res = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', cwd });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

test('Rift 必拦矩阵：跳过门禁/强推/危险删除/受保护路径/reset --hard/clean -x force', () => {
  const mustBlock = [
    { command: 'git commit --no-verify -m "x"' },
    { command: 'git commit --no-verify; echo ok' },
    { command: 'git commit -n -m "x"' },
    { command: 'git push --force origin main' },
    { command: 'git -C repo push --force origin main' },
    { command: 'git push -uf origin main' },
    { command: 'git push origin +HEAD:main' },
    { command: 'git push --force' },
    { command: 'git reset --hard HEAD~1' },
    { command: 'git clean -xfd' },
    { command: 'git clean -x -f' },
    { command: 'rm -r -f /' },
    { command: 'rm -rf ./' },
    { command: 'rm -rf ..' },
    { command: 'rm -rf ~' },
    { command: 'Remove-Item -Recurse -Force .' },
    { command: 'echo SECRET=1 > .env' },
    { filePath: '.env.local' },
    { filePath: 'node_modules/pkg/.env.example' },
    { filePath: 'dist/bundle.js' },
    { filePath: '.git/config' },
  ];
  for (const act of mustBlock) {
    assert.equal(evaluateToolAction(act).allowed, false, `应当拦截：${JSON.stringify(act)}`);
  }
});

test('Rift 必放行矩阵：正常构建/清理产物/lease 强推/非保护分支/.env.example', () => {
  const mustAllow = [
    { command: 'npm run check' },
    { command: 'cargo build --release' },
    { command: 'git push --force-with-lease origin main' },
    { command: 'git push -f origin feat/fix-main-nav' },
    { command: 'rm -rf crates/rift/target' },
    { command: 'cargo clean' },
    { command: 'rm -rf dist && git add .' },
    { command: 'git clean -fd' },
    { command: 'echo EXAMPLE=1 > .env.example' },
    { filePath: '.env.example' },
    { filePath: 'packages/relay/src/index.ts' },
  ];
  for (const act of mustAllow) {
    assert.equal(evaluateToolAction(act).allowed, true, `不应误杀：${JSON.stringify(act)}`);
  }
});

test('extractToolAction 兼容 Qoder tool_input 字段，无 command/file_path 载荷仍可识别', () => {
  assert.equal(extractToolAction({ tool_input: { command: 'npm run check' } }).command, 'npm run check');
  assert.equal(extractToolAction({ tool_input: { file_path: '.env' } }).filePath, '.env');
  assert.equal(extractToolAction({ unknown: true }).recognized, false);
  const bashOutput = extractToolAction({ tool_name: 'BashOutput', tool_input: { bash_id: 'x' } });
  assert.equal(bashOutput.recognized, true);
  assert.equal(bashOutput.command, '');
  assert.equal(bashOutput.filePath, '');
});

test('splitCommandSegments 引号感知分段，复合命令中的违例仍被拦截', () => {
  const segs = splitCommandSegments('echo "a && b" && git commit --no-verify');
  assert.equal(segs.length, 2);
  assert.equal(segs[0], 'echo "a && b"');
  assert.ok(segs[1].includes('--no-verify'));
  assert.equal(evaluateToolAction({ command: 'echo "a && b" && git commit --no-verify' }).allowed, false);
});

test('子进程 fail-closed：空输入/坏 JSON/缺 tool_name/未知结构均 exit 2 + stderr', () => {
  const badInputs = ['', '{invalid-json', JSON.stringify({ unknown: 1 }), JSON.stringify({ tool_input: { command: 'ls' } })];
  for (const input of badInputs) {
    const { status, stdout, stderr } = runHook(input);
    assert.equal(status, 2, `应 fail-closed exit 2：${input}`);
    assert.ok(stderr.includes('拦截'), '拒绝原因须写 stderr');
    assert.ok(!stdout.includes('"allow"'), 'fail-closed 不得放行');
  }
});

test('子进程 allow/deny 协议：正常与无 command 载荷 exit 0 allow，危险命令 exit 2', () => {
  const allowPayloads = [
    { tool_name: 'Bash', tool_input: { command: 'npm run check' } },
    { tool_name: 'BashOutput', tool_input: { bash_id: 'x' } },
    { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'x.ipynb', cell_id: '0' } },
  ];
  for (const payload of allowPayloads) {
    const { status, stdout } = runHook(JSON.stringify(payload));
    assert.equal(status, 0, `应放行：${JSON.stringify(payload)}`);
    assert.equal(JSON.parse(stdout).decision, 'allow');
  }
  const deny = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit --no-verify' } }));
  assert.equal(deny.status, 2);
  assert.ok(deny.stderr.includes('--no-verify'));
});

test('钩子与 CWD 无关：从 ROOT 与临时目录实跑均生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rift-hook-cwd-'));
  try {
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm run check' } });
    for (const cwd of [ROOT, dir]) {
      const { status, stdout } = runHook(payload, cwd);
      assert.equal(status, 0);
      assert.equal(JSON.parse(stdout).decision, 'allow');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('.qoder/settings.json 形状：PreToolUse matcher 与命令模板正确，非锚定命中 BashOutput', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, '.qoder/settings.json'), 'utf8'));
  const def = cfg.hooks.PreToolUse[0];
  assert.equal(def.matcher, 'Bash|Edit|Write|NotebookEdit');
  const handler = def.hooks[0];
  assert.equal(handler.type, 'command');
  assert.equal(handler.timeout, 10);
  assert.ok(handler.command.includes('guard-tool.mjs'));
  assert.ok(handler.command.includes('${QODER_PROJECT_DIR}'));
  const re = new RegExp(def.matcher);
  for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'BashOutput']) {
    assert.ok(re.test(tool), `matcher 应命中 ${tool}`);
  }
});
