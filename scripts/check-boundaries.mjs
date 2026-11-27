#!/usr/bin/env node
/**
 * 确定性架构边界与防御性编码检查（扫描 packages/<pkg>/src）。
 * 使用已 hoisted 的 TypeScript 编译器 API 做 AST 分析（零新增依赖），
 * 覆盖多行 import / export...from / 动态 import()，避免正则词法漏检。
 *
 * 规则：
 * 1. package-layering：跨包仅允许导入 @rift/shared；禁止相对路径逃逸到其他包。
 * 2. no-node-builtins-in-browser：shared / web 为浏览器安全层，禁止导入 node:* 或 Node 内建模块。
 * 3. no-silent-catch：禁止「零语句且零注释」的空 catch {} 静默吞错；
 *    仅含注释的 best-effort catch 合法（Rift 刻意保留，见 docs/SPEC.md §4）。
 *
 * 说明：Rust 侧由 cargo check/test 覆盖；scripts/ 与 tests/ 不在扫描范围（清理路径含刻意空 catch）。
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const BUILTIN_SET = new Set(builtinModules);
const BROWSER_SAFE_PACKAGES = new Set(['shared', 'web']);

/**
 * 轻量词法扫描：精准剔除单行与块注释，保留换行符且绝不破坏字符串/模板字面量内的 // 与 /*。
 * 供 check-test-patterns 复用（按行扫描时避免注释内违例 token 误报）。
 * @param {string} source
 * @param {{ maskStrings?: boolean }} [options]
 */
export function stripJsComments(source, options = {}) {
  const maskStrings = options.maskStrings === true;
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const c = source[i];
        if (c === '\\' && i + 1 < n) {
          out += maskStrings ? (source[i + 1] === '\n' ? ' \n' : '  ') : c + source[i + 1];
          i += 2;
          continue;
        }
        if (c === quote) {
          out += c;
          i += 1;
          break;
        }
        out += maskStrings ? (c === '\n' ? '\n' : ' ') : c;
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * 通过 AST 提取全部导入说明符（静态 import、export...from、动态 import()）。
 * @param {string} source
 * @returns {string[]}
 */
function extractImportSpecifiers(source) {
  const sf = ts.createSourceFile('file.ts', source, ts.ScriptTarget.Latest, true);
  const specs = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return specs;
}

/**
 * @param {string} relPath 相对仓库根的 POSIX 路径
 * @param {string} source
 */
export function checkSourceContent(relPath, source) {
  const violations = [];
  const normalized = relPath.replace(/\\/g, '/');
  const pkgMatch = /^packages\/([^/]+)\//.exec(normalized);
  const pkg = pkgMatch ? pkgMatch[1] : null;
  const sf = ts.createSourceFile(normalized, source, ts.ScriptTarget.Latest, true);

  for (const spec of extractImportSpecifiers(source)) {
    if (spec.startsWith('@rift/')) {
      const target = spec.slice('@rift/'.length).split('/')[0];
      if (target !== 'shared') {
        violations.push(
          `${normalized}: [package-layering] 跨包仅允许导入 @rift/shared，禁止导入 ${spec}`,
        );
      }
      continue;
    }

    if (spec.startsWith('.')) {
      const target = posix.normalize(posix.join(posix.dirname(normalized), spec));
      const targetPkg = /^packages\/([^/]+)\//.exec(target);
      if (targetPkg && pkg && targetPkg[1] !== pkg) {
        violations.push(
          `${normalized}: [package-layering] 禁止相对路径逃逸到其他包 "${targetPkg[1]}"（${target}）`,
        );
      }
      continue;
    }

    if (pkg && BROWSER_SAFE_PACKAGES.has(pkg)) {
      const bare = spec.startsWith('node:') ? spec.slice('node:'.length) : spec;
      if (spec.startsWith('node:') || BUILTIN_SET.has(bare) || BUILTIN_SET.has(bare.split('/')[0])) {
        violations.push(
          `${normalized}: [no-node-builtins-in-browser] 浏览器安全包 "${pkg}" 禁止导入 Node 内建模块 ${spec}`,
        );
      }
    }
  }

  function visitCatch(node) {
    if (ts.isCatchClause(node) && node.block && node.block.statements.length === 0) {
      const inner = source.slice(node.block.getStart(sf) + 1, node.block.end - 1);
      if (inner.trim() === '') {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        violations.push(
          `${normalized}:${line}: [no-silent-catch] 禁止空 catch 块静默吞掉异常（仅含注释的 best-effort catch 合法）`,
        );
      }
    }
    ts.forEachChild(node, visitCatch);
  }
  visitCatch(sf);

  return violations;
}

/**
 * @param {string} dir
 * @param {string[]} acc
 */
function collectSourceFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (/\.(?:mjs|js|ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * @param {string} [rootDir]
 */
export function checkBoundaries(rootDir = ROOT) {
  const packagesDir = join(rootDir, 'packages');
  const files = [];
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        collectSourceFiles(join(packagesDir, entry.name, 'src'), files);
      }
    }
  }
  if (files.length === 0) {
    return {
      fileCount: 0,
      violations: ['packages/*/src: 未发现任何可检查的源码文件，请核对扫描目录配置'],
    };
  }
  const violations = [];
  for (const abs of files) {
    const rel = relative(rootDir, abs).replace(/\\/g, '/');
    violations.push(...checkSourceContent(rel, readFileSync(abs, 'utf8')));
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
  const { fileCount, violations } = checkBoundaries();
  if (violations.length > 0) {
    console.error(`FAIL check-boundaries（发现 ${violations.length} 处违规）：`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`PASS check-boundaries（已检查 ${fileCount} 份源码文件）`);
}
