#!/usr/bin/env node
/**
 * 校验仓库内所有受管/未忽略 Markdown 文件的本地相对链接，确保目标文件或目录真实存在。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.scratch']);
const LOCAL_MD_RE = /(?:^|\/)(?:AGENTS\.override\.md|HANDOFF\.md|[^/]+\.local\.md)$/i;
const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * @param {string} rootDir
 * @returns {string[] | null}
 */
function listGitMarkdownFiles(rootDir) {
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
      .filter((rel) => rel.endsWith('.md'))
      .map((rel) => join(rootDir, rel))
      .filter((abs) => existsSync(abs) && statSync(abs).isFile());
  } catch {
    return null;
  }
}

/**
 * @param {string} rootDir
 * @param {string} dir
 * @param {string[]} acc
 */
function walkMarkdownFiles(rootDir, dir = rootDir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(rootDir, full, acc);
    } else if (entry.name.endsWith('.md')) {
      const rel = relative(rootDir, full).replace(/\\/g, '/');
      if (!LOCAL_MD_RE.test(rel)) acc.push(full);
    }
  }
  return acc;
}

/**
 * 按行状态机剔除围栏代码块（支持列表缩进、~~~ 与多反引号）及行内代码，维持行号不变。
 * @param {string} text
 */
function stripCode(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let fenceChar = null;
  let fenceLen = 0;

  for (const line of lines) {
    if (fenceChar) {
      const closeRe = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`);
      if (closeRe.test(line)) {
        fenceChar = null;
        fenceLen = 0;
      }
      out.push('');
      continue;
    }

    const openMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (openMatch) {
      fenceChar = openMatch[1][0];
      fenceLen = openMatch[1].length;
      out.push('');
      continue;
    }

    out.push(line.replace(/`[^`\n]+`/g, (m) => ' '.repeat(m.length)));
  }

  return out.join('\n');
}

/**
 * @param {string} [rootDir]
 */
export function verifyMarkdownLinks(rootDir = ROOT) {
  const files = listGitMarkdownFiles(rootDir) ?? walkMarkdownFiles(rootDir);
  const failures = [];
  const linkRe = /!?\[[^\]]*\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g;

  for (const absFile of files) {
    const relFile = relative(rootDir, absFile).replace(/\\/g, '/');
    const cleaned = stripCode(readFileSync(absFile, 'utf8'));
    const lines = cleaned.split(/\r?\n/);

    lines.forEach((line, idx) => {
      linkRe.lastIndex = 0;
      let match;
      while ((match = linkRe.exec(line)) !== null) {
        const rawTarget = (match[1] ?? match[2] ?? '').trim();
        if (!rawTarget || rawTarget.startsWith('#') || URI_SCHEME_RE.test(rawTarget)) {
          continue;
        }
        const pathPart = rawTarget.split('#')[0].split('?')[0];
        if (!pathPart) continue;

        let decodedPath = pathPart;
        try {
          decodedPath = decodeURIComponent(pathPart);
        } catch {
          failures.push(`${relFile}:${idx + 1} 相对链接 URL 编码非法 -> ${rawTarget}`);
          continue;
        }

        const resolved = resolve(dirname(absFile), decodedPath);
        if (!existsSync(resolved)) {
          failures.push(`${relFile}:${idx + 1} 相对链接失效 -> ${rawTarget}`);
        }
      }
    });
  }

  return { fileCount: files.length, failures };
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
  const { fileCount, failures } = verifyMarkdownLinks();
  if (failures.length > 0) {
    console.error(`FAIL verify-md-links（发现 ${failures.length} 处断链）：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`PASS verify-md-links（已检查 ${fileCount} 份 Markdown 文档）`);
}
