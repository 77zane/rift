#!/usr/bin/env node
/**
 * 统一本地与 CI 门禁调度器（Rift 适配版）：
 * - node scripts/run-gates.mjs --mode <quick|doc-sync|check>
 * - node scripts/run-gates.mjs --test <unit,boundary,architecture>
 *
 * 与模板差异：测试层分布在 packages/<pkg>/test 与 tests/<layer>；门禁含 npm/cargo 子进程；
 * browser-smoke 在 CI 或 RIFT_REQUIRE_BROWSER=1 时强制要求真实浏览器。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

/** 测试层 → 根目录（相对仓库根）。动态发现 *.test.mjs，避免硬编码漏跑。 */
export const LAYERS = {
  unit: ['packages/shared/test', 'packages/web/test'],
  boundary: ['tests/boundary'],
  architecture: ['tests/architecture'],
};

/**
 * 递归收集指定根目录下的全部 *.test.mjs（按 POSIX 路径排序）。
 * @param {string[]} roots
 * @param {string} [rootDir]
 * @returns {string[]}
 */
export function collectTestFiles(roots, rootDir = ROOT) {
  const results = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.test.mjs')) {
        results.push(relative(rootDir, full).replace(/\\/g, '/'));
      }
    }
  }
  for (const root of roots) walk(join(rootDir, root));
  return results.sort();
}

/**
 * 逐根断言非空，防止某测试层整目录被误删仍静默绿灯。
 * @param {string[]} roots
 * @param {string} rootDir
 */
export function collectRequiredSuites(roots, rootDir) {
  const all = [];
  for (const root of roots) {
    const found = collectTestFiles([root], rootDir);
    if (found.length === 0) {
      throw new Error(`run-gates: 测试层 ${root}/ 未发现任何 *.test.mjs 文件`);
    }
    all.push(...found);
  }
  return all;
}

/**
 * 解析 npm 可执行入口：优先 npm_execpath（npm run 注入），回退 node 同目录 npm-cli.js，
 * 最后才用 shell:true（Windows 裸 npm.cmd spawnSync 会 EINVAL）。
 */
export function resolveNpm() {
  if (process.env.npm_execpath) {
    return { cmd: process.execPath, pre: [process.env.npm_execpath], shell: false };
  }
  const candidate = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(candidate)) {
    return { cmd: process.execPath, pre: [candidate], shell: false };
  }
  return { cmd: 'npm', pre: [], shell: true };
}

/**
 * @param {string} mode
 * @param {string} [rootDir]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{ id: string, kind: 'node'|'npm'|'cargo', args: string[], blocking?: boolean }>}
 */
export function resolveModeGates(mode, rootDir = ROOT, env = process.env) {
  const requireBrowser = env.CI === 'true' || env.RIFT_REQUIRE_BROWSER === '1';
  const node = (id, args, blocking) => ({ id, kind: 'node', args, ...(blocking === false ? { blocking: false } : {}) });
  const npm = (id, args) => ({ id, kind: 'npm', args });
  const cargo = (id, args) => ({ id, kind: 'cargo', args });

  if (mode === 'quick') {
    const unitTests = collectRequiredSuites(LAYERS.unit, rootDir);
    return [
      node('protocol-sync', ['scripts/check-protocol-sync.mjs']),
      node('boundaries', ['scripts/check-boundaries.mjs']),
      node('test-patterns', ['scripts/check-test-patterns.mjs']),
      node('hygiene', ['scripts/check-file-hygiene.mjs', '--check']),
      npm('build:shared', ['run', 'build', '-w', '@rift/shared']),
      node('test:unit', ['--test', ...unitTests]),
    ];
  }

  if (mode === 'doc-sync') {
    return [
      node('doc-budgets', ['scripts/verify-doc-budgets.mjs']),
      node('md-links', ['scripts/verify-md-links.mjs']),
      node('spec-touch', ['scripts/check-spec-touch.mjs'], false),
    ];
  }

  if (mode === 'check') {
    const allTests = collectRequiredSuites([...LAYERS.unit, ...LAYERS.boundary, ...LAYERS.architecture], rootDir);
    return [
      node('doc-budgets', ['scripts/verify-doc-budgets.mjs']),
      node('md-links', ['scripts/verify-md-links.mjs']),
      node('boundaries', ['scripts/check-boundaries.mjs']),
      node('test-patterns', ['scripts/check-test-patterns.mjs']),
      node('hygiene', ['scripts/check-file-hygiene.mjs', '--check']),
      node('protocol-sync', ['scripts/check-protocol-sync.mjs']),
      npm('typecheck', ['run', 'typecheck']),
      npm('build', ['run', 'build']),
      cargo('cargo-check', ['check', '--manifest-path', 'crates/rift/Cargo.toml']),
      node('tests', ['--test', ...allTests]),
      cargo('cargo-test', ['test', '--manifest-path', 'crates/rift/Cargo.toml']),
      node('browser-smoke', ['scripts/browser-smoke.mjs', ...(requireBrowser ? ['--require-browser'] : [])]),
      node('spec-touch', ['scripts/check-spec-touch.mjs'], false),
    ];
  }

  throw new Error(`run-gates: 未知模式 "${mode}"，可选值：quick, doc-sync, check`);
}

/**
 * @param {{ id: string, kind: 'node'|'npm'|'cargo', args: string[] }} gate
 * @param {string} rootDir
 */
function spawnGate(gate, rootDir) {
  if (gate.kind === 'npm') {
    const npm = resolveNpm();
    return spawnSync(npm.cmd, [...npm.pre, ...gate.args], { cwd: rootDir, stdio: 'inherit', shell: npm.shell });
  }
  if (gate.kind === 'cargo') {
    return spawnSync('cargo', gate.args, { cwd: rootDir, stdio: 'inherit' });
  }
  return spawnSync(process.execPath, gate.args, { cwd: rootDir, stdio: 'inherit' });
}

/**
 * @param {string} metaUrl
 */
function isCliEntry(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(metaUrl);
  }
}

if (isCliEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  const testIdx = argv.indexOf('--test');
  if (testIdx >= 0) {
    const rawSuites = argv[testIdx + 1] ?? 'unit,boundary,architecture';
    const suites = rawSuites.split(',').map((s) => s.trim()).filter(Boolean);
    let files;
    try {
      const roots = [];
      for (const suite of suites) {
        if (!LAYERS[suite]) throw new Error(`run-gates: 未知测试层 "${suite}"，可选值：${Object.keys(LAYERS).join(', ')}`);
        roots.push(...LAYERS[suite]);
      }
      files = collectRequiredSuites(roots, ROOT);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    const res = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' });
    process.exit(res.status ?? 1);
  }

  const idx = argv.indexOf('--mode');
  const mode = idx >= 0 ? argv[idx + 1] : 'check';

  let gates;
  try {
    gates = resolveModeGates(mode);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const t0 = performance.now();
  let failedCount = 0;
  console.log(`run-gates [${mode}]：开始执行 ${gates.length} 项门禁...`);

  for (const gate of gates) {
    const start = performance.now();
    const res = spawnGate(gate, ROOT);
    const ms = Math.round(performance.now() - start);
    const ok = res.status === 0;

    if (!ok && gate.blocking !== false) {
      failedCount += 1;
      console.error(`  [FAIL] ${gate.id} (${ms}ms)`);
    } else if (!ok) {
      console.warn(`  [WARN] ${gate.id} 非阻塞门禁异常退出（status=${res.status}, ${ms}ms）`);
    } else {
      console.log(`  [OK]   ${gate.id} (${ms}ms)`);
    }
  }

  const totalMs = Math.round(performance.now() - t0);
  if (failedCount > 0) {
    console.error(`run-gates [${mode}]：失败（${failedCount} 项阻塞门禁未通过，耗时 ${totalMs}ms）`);
    process.exit(1);
  }
  console.log(`run-gates [${mode}]：全部通过（耗时 ${totalMs}ms）`);
}
