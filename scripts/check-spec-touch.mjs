#!/usr/bin/env node
/**
 * 非阻塞活 Spec 触碰提醒：
 * 当核心协议/PTY/Relay/渲染行为文件改动但 docs/SPEC.md 未变动时输出警告，
 * 不阻断纯重构/探索提交；在 GitHub Actions 中自动输出 ::warning 注解。恒退出 0。
 *
 * 改动检测优先级：PR merge-base 对比 → 工作区未提交改动+untracked → push beforeSha 对比 → HEAD~1。
 * env：SPEC_BASE_REF（默认 origin/main）、SPEC_BEFORE_SHA。
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const SPEC_FILE = 'docs/SPEC.md';
const ZERO_SHA = '0000000000000000000000000000000000000000';

export const CORE_WATCH_PATHS = [
  'packages/shared/src/index.ts',
  'crates/rift/src/protocol.rs',
  'crates/rift/src/console.rs',
  'crates/rift/src/proxy.rs',
  'crates/rift/src/setup.rs',
  'crates/rift/src/daemon.rs',
  'crates/rift/src/agent_hook.rs',
  'packages/relay/src/index.ts',
  'packages/web/src/terminal-utils.ts',
  'packages/web/vite.config.ts',
];

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function tryGit(args, cwd) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 收集受检改动文件（兼容 PR 分支对比、push 到默认分支对比以及本地未提交改动）。
 * @param {string} rootDir
 * @param {string} baseRef
 * @param {string} [beforeSha]
 */
export function getChangedFiles(rootDir, baseRef, beforeSha = '') {
  const insideGit = tryGit(['rev-parse', '--is-inside-work-tree'], rootDir);
  if (insideGit !== 'true') return [];

  const headSha = tryGit(['rev-parse', '--verify', 'HEAD'], rootDir);
  const untracked = tryGit(['ls-files', '--others', '--exclude-standard'], rootDir) ?? '';
  if (!headSha) {
    return [...new Set(untracked.split(/\r?\n/).filter(Boolean))];
  }

  let tracked = '';
  const mergeBase = baseRef ? tryGit(['merge-base', baseRef, 'HEAD'], rootDir) : null;

  if (mergeBase && mergeBase !== headSha) {
    tracked = tryGit(['diff', '--name-only', mergeBase], rootDir) ?? '';
  } else {
    // 已在基线分支上时优先检查工作区未提交改动；若工作区干净（如 CI push），再对比上次提交。
    const workingTree = tryGit(['diff', '--name-only', 'HEAD'], rootDir) ?? '';
    if (workingTree || untracked) {
      tracked = workingTree;
    } else if (beforeSha && beforeSha !== ZERO_SHA && tryGit(['cat-file', '-e', `${beforeSha}^{commit}`], rootDir) !== null) {
      tracked = tryGit(['diff', '--name-only', `${beforeSha}..HEAD`], rootDir) ?? '';
    } else if (tryGit(['rev-parse', '--verify', 'HEAD~1'], rootDir)) {
      tracked = tryGit(['diff', '--name-only', 'HEAD~1..HEAD'], rootDir) ?? '';
    }
  }

  return [...new Set(`${tracked}\n${untracked}`.split(/\r?\n/).filter(Boolean))];
}

/**
 * @param {string} [rootDir]
 * @param {string} [baseRef]
 * @param {string} [beforeSha]
 */
export function checkSpecTouch(
  rootDir = ROOT,
  baseRef = process.env.SPEC_BASE_REF || 'origin/main',
  beforeSha = process.env.SPEC_BEFORE_SHA || '',
) {
  const changed = getChangedFiles(rootDir, baseRef, beforeSha);
  const touchedCore = changed.filter((f) => CORE_WATCH_PATHS.includes(f));
  const touchedSpec = changed.includes(SPEC_FILE);
  return { touchedCore, touchedSpec, stale: touchedCore.length > 0 && !touchedSpec };
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
  const { touchedCore, stale } = checkSpecTouch();
  if (!stale) {
    console.log('[check:spec] OK');
    process.exit(0);
  }

  const msg =
    `核心行为/协议文件已改动（${touchedCore.join(', ')}），但 ${SPEC_FILE} 未同步更新。` +
    '若本次改动影响了红线、协议不变量或已验证边界，请在同一改动中更新 docs/SPEC.md。';
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::warning title=活 Spec 未同步更新::${msg}`);
  } else {
    console.warn(`[check:spec] WARN: ${msg}`);
  }
  process.exit(0);
}
