/**
 * tests/architecture —— 门禁反例自测（可证伪红灯）。
 * 每个门禁都验证「撤掉修复/注入违例确实报红」，夹具用 mkdtemp 隔离，
 * 含违例 token 的源行一律字符串拼接断开 + `// harness-fixture` 行标记豁免。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkBoundaries, checkSourceContent } from '../../scripts/check-boundaries.mjs';
import { checkFileHygiene } from '../../scripts/check-file-hygiene.mjs';
import { checkProtocolSync } from '../../scripts/check-protocol-sync.mjs';
import { checkSpecTouch, getChangedFiles, CORE_WATCH_PATHS } from '../../scripts/check-spec-touch.mjs';
import { checkTestPatterns, findTestPatternViolations } from '../../scripts/check-test-patterns.mjs';
import { collectTestFiles, collectRequiredSuites, resolveModeGates, LAYERS } from '../../scripts/run-gates.mjs';
import { checkDocBudgets, countUnits } from '../../scripts/verify-doc-budgets.mjs';
import { verifyMarkdownLinks } from '../../scripts/verify-md-links.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/** 在系统临时目录执行隔离回调并确保清理。 */
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rift-harness-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 在临时目录初始化一个含主分支的 git 仓库。 */
function initGitRepo(dir) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  return git;
}

test('countUnits 中英混合计数：CJK 逐字、ASCII 逐词', () => {
  assert.equal(countUnits('检查清单 AGENTS.md check'), 6);
  assert.equal(countUnits('你好世界'), 4);
  assert.equal(countUnits('foo-bar.baz qux'), 2);
  assert.equal(countUnits(''), 0);
});

test('反例：verify-doc-budgets 拦截超预算/缺文件/非法清单，并按 LF 稳定计字节', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'OK.md'), '一行测试\r\n两行测试\r\n');
    writeFileSync(join(dir, 'OVER.md'), '超限内容'.repeat(20) + '\n');
    writeFileSync(
      join(dir, 'scripts/doc-budgets.manifest.json'),
      JSON.stringify({
        'OK.md': { maxUnits: 20, maxBytes: 26 },
        'OVER.md': { maxUnits: 10, maxBytes: 50 },
        'MISSING.md': { maxUnits: 10 },
        'BAD.md': { maxUnits: '100' },
        'UNK.md': { maxUnits: 10, foo: 1 },
      }),
    );
    const { failures } = checkDocBudgets(dir);
    assert.ok(!failures.some((f) => f.startsWith('OK.md')), 'CRLF 归一后 OK.md 不应误判超字节');
    assert.ok(failures.some((f) => f.startsWith('OVER.md') && f.includes('有效词字数')));
    assert.ok(failures.some((f) => f.startsWith('OVER.md') && f.includes('字节数')));
    assert.ok(failures.some((f) => f.startsWith('MISSING.md')));
    assert.ok(failures.some((f) => f.startsWith('BAD.md')));
    assert.ok(failures.some((f) => f.startsWith('UNK.md') && f.includes('未知字段')));
  });
});

test('反例：verify-md-links 拦截断链与畸形 URL，正确处理缩进围栏/查询串/尖括号/scheme/私有文档', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'target file.md'), '# ok\n');
    writeFileSync(join(dir, 'HANDOFF.md'), '[broken](missing-in-local.md)\n');
    writeFileSync(
      join(dir, 'doc.md'),
      [
        '[ok-query](target%20file.md?plain=1#top)',
        '[ok-angle](<target file.md>)',
        '[ok-scheme](data:text/plain;base64,SGk=)',
        '- 示例：',
        '  ```md',
        '  [ignored-in-indented-fence](does-not-exist.md)',
        '  ```',
        '[real-broken](./not-found.md)',
        '[bad-pct](./100%ZZ.md)',
      ].join('\n') + '\n',
    );
    const { failures } = verifyMarkdownLinks(dir);
    assert.equal(failures.length, 2, `预期 2 处失败，实际：${failures.join('; ')}`);
    assert.ok(failures.some((f) => f.includes('not-found.md')));
    assert.ok(failures.some((f) => f.includes('100%ZZ.md')));
  });
});

test('反例：check-file-hygiene 拦截坏 JSON/冲突符/换行问题，--fix 不破坏纯 CRLF 且跳过私有文件', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'bad.json'), '{bad\n');
    writeFileSync(join(dir, 'conflict.txt'), 'ok\n' + '>>>' + '>>>> branch\n');
    writeFileSync(join(dir, 'crlf-no-eol.txt'), 'line1\r\nline2');
    writeFileSync(join(dir, 'mixed.txt'), 'a\r\nb\nc');
    writeFileSync(join(dir, '.env'), 'SECRET=1');

    const before = checkFileHygiene(dir, { fix: false });
    assert.ok(before.errors.some((e) => e.startsWith('bad.json')));
    assert.ok(before.errors.some((e) => e.startsWith('conflict.txt')));
    assert.ok(before.errors.some((e) => e.startsWith('crlf-no-eol.txt')));
    assert.ok(before.errors.some((e) => e.startsWith('mixed.txt')));
    assert.ok(!before.errors.some((e) => e.startsWith('.env')), '私有 .env 应被跳过');

    checkFileHygiene(dir, { fix: true });
    assert.equal(readFileSync(join(dir, 'crlf-no-eol.txt'), 'utf8'), 'line1\r\nline2\r\n');
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'SECRET=1');

    const after = checkFileHygiene(dir, { fix: false });
    assert.ok(!after.errors.some((e) => e.startsWith('crlf-no-eol.txt')));
    assert.ok(!after.errors.some((e) => e.startsWith('mixed.txt')));
  });
});

test('反例：check-test-patterns 拦截聚焦/跳过/睡眠/空断言，豁免仅限 architecture，注释不诱骗', () => {
  const exemptInArch = [
    'test.' + 'only("exempt", () => {}); // harness-fixture',
    'set' + 'Timeout(() => {}, 10); // harness-fixture',
  ].join('\n');
  assert.equal(findTestPatternViolations('tests/architecture/fake.test.mjs', exemptInArch).length, 0);
  assert.equal(findTestPatternViolations('tests/unit/fake.test.mjs', exemptInArch).length, 2);

  assert.equal(
    findTestPatternViolations(
      'tests/unit/comment.test.mjs',
      'assert.equal(1, 1); // no set' + 'Timeout() here\n', // harness-fixture
    ).length,
    0,
  );

  const realBad = [
    '/* note */ test.' + 'only("x", () => {});', // harness-fixture
    'test("opt", { only: true }, () => {});', // harness-fixture
    'test("skip", { skip: "later" }, () => {});', // harness-fixture
    'test.' + 'todo("pending");', // harness-fixture
    'set' + 'Timeout(() => {}, 50);', // harness-fixture
    'assert.' + 'ok(true);', // harness-fixture
  ].join('\n');
  assert.equal(findTestPatternViolations('tests/unit/bad.test.mjs', realBad).length, 6);

  withTempDir((dir) => {
    assert.ok(checkTestPatterns(dir).violations.length > 0, '空 tests/ 必须失败');
  });
});

test('反例：check-boundaries 拦截跨包/相对逃逸/浏览器内建/真空 catch，AST 不被多行与字符串欺骗', () => {
  const layering = (rel, src) => checkSourceContent(rel, src).some((v) => v.includes('package-layering'));
  assert.ok(layering('packages/relay/src/bad.ts', "import { x } from '@rift/agent';\n"));
  assert.ok(layering('packages/shared/src/bad.ts', "import { y } from '@rift/relay';\n"));
  assert.ok(layering('packages/web/src/bad.ts', "import { z } from '../../relay/src/index';\n"));
  assert.ok(layering('packages/relay/src/multi.ts', "import {\n  foo,\n  bar,\n} from '@rift/agent';\n"));
  assert.ok(layering('packages/relay/src/dyn.ts', "const m = await import('@rift/agent');\n"));
  assert.ok(layering('packages/relay/src/exp.ts', "export { x } from '@rift/agent';\n"));
  assert.ok(layering('packages/relay/src/nospace.ts', "import { x } from'@rift/agent';\n"));

  const browser = (rel, src) => checkSourceContent(rel, src).some((v) => v.includes('no-node-builtins-in-browser'));
  assert.ok(browser('packages/web/src/bad.ts', "import fs from 'node:fs';\n"));
  assert.ok(browser('packages/shared/src/bad.ts', "import { readFile } from 'fs';\n"));
  // relay/agent 非浏览器安全层，允许 node 内建
  assert.equal(checkSourceContent('packages/relay/src/ok.ts', "import fs from 'node:fs';\n").length, 0);
  // 跨包仅允许 @rift/shared
  assert.equal(checkSourceContent('packages/relay/src/ok.ts', "import { FRAME_PTY_OUTPUT } from '@rift/shared';\n").length, 0);

  // 真空 catch FAIL vs 仅注释 catch PASS
  assert.ok(checkSourceContent('packages/relay/src/c.ts', 'try { work(); } catch {}\n').some((v) => v.includes('no-silent-catch')));
  assert.equal(checkSourceContent('packages/relay/src/c.ts', 'try { work(); } catch { /* best-effort */ }\n').length, 0);

  // 字符串里的 import 文本不应假阳性
  assert.equal(checkSourceContent('packages/relay/src/s.ts', 'export function f() { return "import x from \'@rift/agent\'"; }\n').length, 0);

  withTempDir((dir) => {
    assert.ok(checkBoundaries(dir).violations.length > 0, '空 packages/*/src 必须失败');
  });
});

test('反例：check-spec-touch 检出核心改动而 SPEC 未更新，同步后清零，覆盖 beforeSha 分支', () => {
  for (const p of ['crates/rift/src/daemon.rs', 'crates/rift/src/agent_hook.rs', 'packages/web/src/terminal-utils.ts', 'packages/web/vite.config.ts']) {
    assert.ok(CORE_WATCH_PATHS.includes(p), `watch list 应含 ${p}`);
  }
  withTempDir((dir) => {
    const git = initGitRepo(dir);
    mkdirSync(join(dir, 'packages/relay/src'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'packages/relay/src/index.ts'), 'export const v = 1;\n');
    writeFileSync(join(dir, 'docs/SPEC.md'), '# Spec\n');
    git('add', '.');
    git('commit', '-m', 'init');

    writeFileSync(join(dir, 'packages/relay/src/index.ts'), 'export const v = 2;\n');
    const stale = checkSpecTouch(dir, 'main');
    assert.equal(stale.stale, true);
    assert.ok(stale.touchedCore.includes('packages/relay/src/index.ts'));

    writeFileSync(join(dir, 'docs/SPEC.md'), '# Spec v2\n');
    assert.equal(checkSpecTouch(dir, 'main').stale, false);

    // beforeSha 分支：工作区干净时对比上次提交（取 core-only 提交的父提交，diff 仅含核心文件）
    git('add', '.');
    git('commit', '-m', 'sync spec');
    writeFileSync(join(dir, 'packages/relay/src/index.ts'), 'export const v = 3;\n');
    git('add', '.');
    git('commit', '-m', 'core only');
    const beforeSha = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: dir, encoding: 'utf8' }).trim();
    const viaBefore = checkSpecTouch(dir, 'main', beforeSha);
    assert.ok(viaBefore.touchedCore.includes('packages/relay/src/index.ts'));
    assert.equal(viaBefore.touchedSpec, false);
    assert.ok(getChangedFiles(dir, 'main', beforeSha).includes('packages/relay/src/index.ts'));
  });
});

test('反例：check-protocol-sync 真仓同源 OK，帧常量与变体漂移立即 FAIL', () => {
  assert.equal(checkProtocolSync(ROOT).ok, true, '真实仓库 TS/Rust 协议必须同源');

  const seed = (dir) => {
    mkdirSync(join(dir, 'packages/shared/src'), { recursive: true });
    mkdirSync(join(dir, 'crates/rift/src'), { recursive: true });
    copyFileSync(join(ROOT, 'packages/shared/src/index.ts'), join(dir, 'packages/shared/src/index.ts'));
    copyFileSync(join(ROOT, 'crates/rift/src/protocol.rs'), join(dir, 'crates/rift/src/protocol.rs'));
  };

  withTempDir((dir) => {
    seed(dir);
    assert.equal(checkProtocolSync(dir).ok, true);
    const tsPath = join(dir, 'packages/shared/src/index.ts');
    writeFileSync(tsPath, readFileSync(tsPath, 'utf8').replace('FRAME_PTY_OUTPUT = 0x01', 'FRAME_PTY_OUTPUT = 0x09'));
    const res = checkProtocolSync(dir);
    assert.equal(res.ok, false);
    assert.ok(res.failures.some((f) => f.includes('FRAME_PTY_OUTPUT')));
  });

  withTempDir((dir) => {
    seed(dir);
    const tsPath = join(dir, 'packages/shared/src/index.ts');
    writeFileSync(tsPath, readFileSync(tsPath, 'utf8').replace('type: "web.sync";', 'type: "web.syncX";'));
    const res = checkProtocolSync(dir);
    assert.equal(res.ok, false);
    assert.ok(res.failures.some((f) => f.includes('web.sync')));
  });
});

test('反例：run-gates 动态发现三层、空层 throw、未知模式 throw、browser 标志策略与非阻塞 WARN', () => {
  const unit = collectTestFiles(LAYERS.unit, ROOT);
  assert.ok(unit.includes('packages/shared/test/shared.test.mjs'));
  assert.ok(unit.includes('packages/web/test/terminal-utils.test.mjs'));
  assert.ok(collectTestFiles(LAYERS.architecture, ROOT).includes('tests/architecture/harness-gates.test.mjs'));
  assert.ok(collectTestFiles(LAYERS.boundary, ROOT).includes('tests/boundary/relay-replay.test.mjs'));

  withTempDir((dir) => {
    mkdirSync(join(dir, 'packages/shared/test'), { recursive: true });
    writeFileSync(join(dir, 'packages/shared/test/a.test.mjs'), 'export {};\n');
    assert.throws(() => collectRequiredSuites(LAYERS.unit, dir), /packages\/web\/test/);
    mkdirSync(join(dir, 'packages/web/test'), { recursive: true });
    writeFileSync(join(dir, 'packages/web/test/b.test.mjs'), 'export {};\n');
    assert.throws(() => resolveModeGates('check', dir), /tests\/boundary/);
  });

  assert.throws(() => resolveModeGates('bogus', ROOT), /未知模式/);

  const withBrowser = resolveModeGates('check', ROOT, { CI: 'true' }).find((g) => g.id === 'browser-smoke');
  assert.ok(withBrowser.args.includes('--require-browser'));
  const noBrowser = resolveModeGates('check', ROOT, {}).find((g) => g.id === 'browser-smoke');
  assert.ok(!noBrowser.args.includes('--require-browser'));

  const docSync = resolveModeGates('doc-sync', ROOT);
  assert.equal(docSync.find((g) => g.id === 'spec-touch').blocking, false);
  assert.ok(resolveModeGates('quick', ROOT).every((g) => g.kind !== 'cargo'), 'quick 模式不应含 cargo');
});
