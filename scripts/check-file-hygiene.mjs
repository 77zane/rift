#!/usr/bin/env node
/**
 * 双模式文件卫生门禁（自动尊重 .gitignore，不碰开发者本地私有文件）：
 * - --check（CI 与 npm run check）：只校验不改文件，发现问题非零退出
 * - --fix  （本地便捷修复）：自动统一混用换行符并按一致风格补齐文件尾换行
 *
 * 检查项：JSON 语法合法、无残留 Git 合并冲突标记（行首锚定）、无混用 CRLF/LF、文本文件以换行符结尾。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.scratch']);
const LOCAL_PRIVATE_RE =
  /(?:^|\/)(?:\.env(?!\.example$)(?:\.[^/]+)?|AGENTS\.override\.md|HANDOFF\.md|[^/]+\.local\.[^/]+|[^/]+\.log)$/i;
// 拆分拼接冲突符字面量，防止本脚本扫描自身时误报。
const MERGE_CONFLICT_RE = new RegExp(
  `^(?:${'<<<' + '<<<<'} |${'===' + '===='}$|${'>>>' + '>>>>'} )`,
  'm',
);

/**
 * 优先通过 git ls-files 获取受管及未忽略文件，确保完全尊重 .gitignore。
 * @param {string} rootDir
 * @returns {string[] | null}
 */
function listGitVisibleFiles(rootDir) {
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (inside !== 'true') return null;

    const out = execFileSync(
      'git',
      ['-c', 'core.quotepath=false', 'ls-files', '-co', '--exclude-standard', '-z'],
      { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out
      .split('\0')
      .filter(Boolean)
      .map((rel) => join(rootDir, rel))
      .filter((abs) => existsSync(abs) && statSync(abs).isFile());
  } catch {
    return null;
  }
}

/**
 * 非 Git 环境兜底遍历（显式跳过忽略目录与本地私有文件）。
 * @param {string} rootDir
 * @param {string} dir
 * @param {string[]} acc
 */
function walkFallbackFiles(rootDir, dir = rootDir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFallbackFiles(rootDir, full, acc);
    } else {
      const rel = relative(rootDir, full).replace(/\\/g, '/');
      if (!LOCAL_PRIVATE_RE.test(rel)) {
        acc.push(full);
      }
    }
  }
  return acc;
}

/**
 * @param {Buffer} buf
 */
function isBinary(buf) {
  return buf.includes(0);
}

/**
 * @param {string} [rootDir]
 * @param {{ fix?: boolean }} [options]
 */
export function checkFileHygiene(rootDir = ROOT, options = {}) {
  const fix = options.fix === true;
  const files = listGitVisibleFiles(rootDir) ?? walkFallbackFiles(rootDir);
  const errors = [];
  const fixed = [];

  for (const abs of files) {
    const rel = relative(rootDir, abs).replace(/\\/g, '/');
    const raw = readFileSync(abs);
    if (raw.length === 0 || isBinary(raw)) continue;

    let text = raw.toString('utf8');
    let modified = false;

    if (extname(abs) === '.json') {
      try {
        JSON.parse(text);
      } catch (err) {
        errors.push(`${rel}: JSON 语法无效（${err.message}）`);
      }
    }

    if (MERGE_CONFLICT_RE.test(text)) {
      errors.push(`${rel}: 检测到未解决的 Git 合并冲突标记`);
    }

    let hasCrlf = text.includes('\r\n');
    const hasBareLf = text.replace(/\r\n/g, '').includes('\n');
    if (hasCrlf && hasBareLf) {
      if (fix) {
        text = text.replace(/\r\n/g, '\n');
        hasCrlf = false;
        modified = true;
        fixed.push(`${rel}: 已统一混用换行符为 LF`);
      } else {
        errors.push(`${rel}: 混用 CRLF 与 LF 换行符（请运行 npm run fix:hygiene）`);
      }
    }

    if (!text.endsWith('\n')) {
      if (fix) {
        // 保持与文件既有换行风格一致，避免把纯 CRLF 文件改坏成混用换行。
        text += hasCrlf ? '\r\n' : '\n';
        modified = true;
        fixed.push(`${rel}: 已补齐文件尾换行`);
      } else {
        errors.push(`${rel}: 缺少文件尾换行符（请运行 npm run fix:hygiene）`);
      }
    }

    if (modified) {
      writeFileSync(abs, text, 'utf8');
    }
  }

  return { fileCount: files.length, errors, fixed };
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
  const fix = process.argv.includes('--fix');
  const { fileCount, errors, fixed } = checkFileHygiene(ROOT, { fix });

  for (const note of fixed) console.log(`FIXED ${note}`);

  if (errors.length > 0) {
    console.error(`FAIL check-file-hygiene（发现 ${errors.length} 处问题）：`);
    for (const err of errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  console.log(`PASS check-file-hygiene（已检查 ${fileCount} 个文件${fix ? `，自动修复 ${fixed.length} 处` : ''}）`);
}
