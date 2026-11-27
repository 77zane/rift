#!/usr/bin/env node
/**
 * 强制校验常驻文档的中英混合有效词字数（maxUnits）与规范化 LF UTF-8 字节数（maxBytes）预算。
 * 清单配置见 scripts/doc-budgets.manifest.json。
 * 用法：node scripts/verify-doc-budgets.mjs [--list]
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

/**
 * 统计中英混合有效词字数：每个 CJK 汉字计 1，每个连续英文/数字词计 1。
 * 避免纯空格分词（wc -w）把整段无空格中文误算成 1 个词。
 * @param {string} text
 */
export function countUnits(text) {
  const cjk = text.match(/[一-鿿㐀-䶿]/g)?.length ?? 0;
  const asciiWords =
    text.replace(/[一-鿿㐀-䶿]/g, ' ').match(/[A-Za-z0-9_./-]+/g)?.length ?? 0;
  return cjk + asciiWords;
}

/**
 * @param {unknown} value
 */
function isPositiveSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * @param {string} [rootDir]
 */
export function checkDocBudgets(rootDir = ROOT) {
  const manifestPath = resolve(rootDir, 'scripts/doc-budgets.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const failures = [];
  const rows = [];

  for (const [relPath, limits] of Object.entries(manifest)) {
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
      failures.push(`${relPath}: 预算配置必须为对象`);
      continue;
    }

    const unknownKeys = Object.keys(limits).filter((k) => k !== 'maxUnits' && k !== 'maxBytes');
    if (unknownKeys.length > 0) {
      failures.push(`${relPath}: 预算配置含未知字段 ${unknownKeys.join(', ')}`);
      continue;
    }

    const hasUnits = Object.hasOwn(limits, 'maxUnits');
    const hasBytes = Object.hasOwn(limits, 'maxBytes');
    if ((!hasUnits && !hasBytes) || (hasUnits && !isPositiveSafeInt(limits.maxUnits)) || (hasBytes && !isPositiveSafeInt(limits.maxBytes))) {
      failures.push(`${relPath}: maxUnits / maxBytes 必须为正安全整数`);
      continue;
    }

    const absPath = resolve(rootDir, relPath);
    if (!existsSync(absPath)) {
      rows.push(`MISS  ${relPath}`);
      failures.push(`${relPath}: 清单中的预算文档不存在（若已改名/删除请同步更新 scripts/doc-budgets.manifest.json）`);
      continue;
    }

    // 统一按 LF 计字节，避免 Windows CRLF 检出与 Linux CI 产生字节漂移。
    const content = readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
    const units = countUnits(content);
    const bytes = Buffer.byteLength(content, 'utf8');
    const overUnits = hasUnits && units > limits.maxUnits;
    const overBytes = hasBytes && bytes > limits.maxBytes;

    const status = overUnits || overBytes ? 'OVER' : 'ok  ';
    rows.push(
      `${status}  units=${String(units).padStart(4)}/${String(limits.maxUnits ?? '-').padEnd(4)}  bytes=${String(bytes).padStart(5)}/${String(limits.maxBytes ?? '-').padEnd(5)}  ${relPath}`,
    );

    if (overUnits) {
      failures.push(
        `${relPath}: 有效词字数 ${units} 超出上限 ${limits.maxUnits} —— 请按 AGENTS.md 预算规则将细节下沉或精简`,
      );
    }
    if (overBytes) {
      failures.push(
        `${relPath}: 字节数 ${bytes} 超出上限 ${limits.maxBytes} —— 请按 AGENTS.md 预算规则将细节下沉或精简`,
      );
    }
  }

  return { rows, failures };
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
  const { rows, failures } = checkDocBudgets();
  const listOnly = process.argv.includes('--list');

  if (listOnly) {
    console.log(rows.join('\n'));
    process.exit(0);
  }

  if (failures.length > 0) {
    console.error('FAIL verify-doc-budgets:');
    for (const msg of failures) console.error(`  - ${msg}`);
    process.exit(1);
  }

  console.log(`PASS verify-doc-budgets（${rows.length} 份常驻文档均在预算上限内）`);
}
