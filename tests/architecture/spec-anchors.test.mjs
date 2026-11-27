/**
 * tests/architecture —— 活文档锚点与架构不变量静态钉住。
 * SPEC 引用的源码锚点必须真实存在；AGENTS.md 路由链完整；预算清单恰好覆盖两文档；
 * vite build.target=es2022 与 @xterm/xterm major 6 不得降级。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const ANCHOR_RE = /`((?:packages|crates|scripts|docs|tests)\/[A-Za-z0-9_./-]+\.(?:ts|rs|mjs|md|json))`/g;

/** 提取文本中反引号包裹的源码锚点（去重，仅文件路径，排除目录/生成物）。 */
function anchorsIn(text) {
  return [...new Set([...text.matchAll(ANCHOR_RE)].map((m) => m[1]))];
}

/** 返回文本中引用但实际不存在的锚点。 */
function missingAnchors(text, root = ROOT) {
  return anchorsIn(text).filter((rel) => !existsSync(join(root, rel)));
}

test('docs/SPEC.md 引用的全部源码锚点真实存在（≥11 处），坏锚点夹具可检出', () => {
  const spec = readFileSync(join(ROOT, 'docs/SPEC.md'), 'utf8');
  const anchors = anchorsIn(spec);
  assert.ok(anchors.length >= 11, `SPEC 源码锚点应 ≥11，实际 ${anchors.length}`);
  assert.deepEqual(missingAnchors(spec), [], 'SPEC 引用了不存在的源码锚点');

  const fixture = '锚点 `packages/relay/src/index.ts` 与坏锚点 `packages/relay/src/nope.ts`';
  assert.deepEqual(missingAnchors(fixture), ['packages/relay/src/nope.ts']);
});

test('AGENTS.md 路由链指向 docs/SPEC.md 与 pre-pr-check 技能', () => {
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('docs/SPEC.md'), 'AGENTS.md 必须指向 docs/SPEC.md');
  assert.ok(agents.includes('pre-pr-check'), 'AGENTS.md 必须指向 pre-pr-check 技能');
});

test('预算清单恰好覆盖 AGENTS.md 与 docs/SPEC.md 两份常驻文档', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'scripts/doc-budgets.manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['AGENTS.md', 'docs/SPEC.md']);
});

test('架构不变量钉住：vite build.target=es2022，@xterm/xterm major 6', () => {
  const vite = readFileSync(join(ROOT, 'packages/web/vite.config.ts'), 'utf8');
  assert.match(vite, /target:\s*"es2022"/, 'vite build.target 必须为 es2022（严禁降级 es2020）');

  const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/web/package.json'), 'utf8'));
  const range = pkg.dependencies['@xterm/xterm'];
  assert.equal(typeof range, 'string');
  const major = Number(range.replace(/^[^\d]*/, '').split('.')[0]);
  assert.equal(major, 6, '@xterm/xterm 必须为 major 6');
});
