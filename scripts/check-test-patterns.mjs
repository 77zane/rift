#!/usr/bin/env node
/**
 * 拦截高频测试反模式（扫描 packages/<pkg>/test 与 tests/<layer>）：
 * - 提交 .only() / .skip() / .todo() 或 node:test 选项对象 { only: true } / { skip: ... } / { todo: ... }
 * - 使用固定 setTimeout() 睡眠制造脆弱/慢速测试
 * - 无意义空断言 assert.ok(true)
 *
 * `harness-fixture` 行标记豁免仅限 tests/architecture/（门禁反例夹具需故意包含违例 token）。
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsComments } from './check-boundaries.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

const RULES = [
  {
    id: 'no-focused-or-skipped-test',
    re: /\b(?:(?:test|it|describe)\.(?:only|skip|todo)|t\.skip)\s*\(|\{\s*(?:only|skip|todo)\s*:\s*(?:true|['"`][^'"`]+['"`])\s*[,}]/,
    hint: '严禁提交聚焦、跳过或 todo 占位测试（.only/.skip/.todo 或 { only/skip/todo }）',
  },
  {
    id: 'no-fixed-sleep',
    re: /\bsetTimeout\s*\(/,
    hint: '测试中禁止使用固定 setTimeout 睡眠，请改用确定性事件或信号同步',
  },
  {
    id: 'no-vacuous-assertion',
    re: /\bassert\.ok\s*\(\s*true\s*\)/,
    hint: '禁止无意义空断言 assert.ok(true)，请断言外部可观测状态或输出',
  },
];

/**
 * 动态收集测试根目录：packages/<pkg>/test 与 tests/<layer>。
 * @param {string} rootDir
 * @returns {string[]}
 */
function testRoots(rootDir) {
  const roots = [];
  const packagesDir = join(rootDir, 'packages');
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'test'))) {
        roots.push(`packages/${entry.name}/test`);
      }
    }
  }
  const testsDir = join(rootDir, 'tests');
  if (existsSync(testsDir)) {
    for (const entry of readdirSync(testsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(`tests/${entry.name}`);
    }
  }
  return roots;
}

/**
 * @param {string} dir
 * @param {string[]} acc
 */
function collectTestFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(full, acc);
    } else if (/\.test\.(?:mjs|js|ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * @param {string} relPath
 * @param {string} content
 */
export function findTestPatternViolations(relPath, content) {
  const normalized = relPath.replace(/\\/g, '/');
  const allowFixture = normalized.startsWith('tests/architecture/');
  const rawLines = content.split(/\r?\n/);
  const cleanedLines = stripJsComments(content).split(/\r?\n/);
  const violations = [];

  cleanedLines.forEach((line, idx) => {
    const rawLine = rawLines[idx] ?? '';
    if (allowFixture && rawLine.includes('harness-fixture')) return;
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        violations.push({
          file: normalized,
          line: idx + 1,
          rule: rule.id,
          hint: rule.hint,
        });
      }
    }
  });

  return violations;
}

/**
 * @param {string} [rootDir]
 */
export function checkTestPatterns(rootDir = ROOT) {
  const roots = testRoots(rootDir);
  const files = [];
  for (const root of roots) collectTestFiles(join(rootDir, root), files);

  if (files.length === 0) {
    return {
      fileCount: 0,
      violations: [
        {
          file: 'tests/',
          line: 1,
          rule: 'no-test-files',
          hint: '未在 packages/*/test 或 tests/ 下发现任何测试文件，请核对扫描目录配置',
        },
      ],
    };
  }
  const violations = [];
  for (const abs of files) {
    const rel = relative(rootDir, abs).replace(/\\/g, '/');
    violations.push(...findTestPatternViolations(rel, readFileSync(abs, 'utf8')));
  }
  return { fileCount: files.length, violations };
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
  const { fileCount, violations } = checkTestPatterns();
  if (violations.length > 0) {
    console.error(`FAIL check-test-patterns（发现 ${violations.length} 处反模式）：`);
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line} [${v.rule}] ${v.hint}`);
    }
    process.exit(1);
  }
  console.log(`PASS check-test-patterns（已检查 ${fileCount} 份测试文件）`);
}
