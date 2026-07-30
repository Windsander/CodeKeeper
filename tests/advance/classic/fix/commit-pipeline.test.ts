/**
 * commit-pipeline 单元测试
 *
 * 夹具取材自 example_desktop MR !1558 的真实失败现场（见回归文档）。
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyCommitFailure,
  detectCommitConvention,
  distillCommitFailure,
  buildDefaultBatchMessage,
  buildDefaultDeleteMessage,
  buildDefaultFixMessage,
} from '../../../../src/advance/classic/fix/commit-pipeline.js';

const CONVENTIONAL = /^[a-z]+(?:\([^)]*\))?:\s/i;

describe('classifyCommitFailure', () => {
  it('!1558 现场：几千行 lint 噪音尾部的 commit-msg 拒绝归类为 commit-message', () => {
    const lintNoise = Array.from(
      { length: 500 },
      (_, i) => `src/some/file-${i}.ts\n  ${i}:26  warning  Forbidden non-null assertion`
    ).join('\n');
    const raw = `Worktree commit 失败:\n${lintNoise}\n❌ Commit message 不符合 Conventional Commits 规范。\n格式: (<scope>):\ntypes: feat | fix | docs | chore\n当前: 批量修复 1 个 Reviewer 问题`;
    expect(classifyCommitFailure(raw)).toBe('commit-message');
  });

  it('项目自定义模板（提交标题不符合项目模板）归类为 commit-message', () => {
    const raw = `❌ 提交标题不符合项目模板。\n要求: [任务编号] 简短说明\n当前: 批量修复 1 个 Reviewer 问题`;
    expect(classifyCommitFailure(raw)).toBe('commit-message');
  });

  it('eslint error 归类为 lint', () => {
    const raw = `src/index.ts\n  2:7  error  no-unused-vars\n✖ 3 problems (3 errors, 0 warnings)`;
    expect(classifyCommitFailure(raw)).toBe('lint');
  });

  it('测试失败归类为 test', () => {
    const raw = ` FAIL  src/index.test.ts > 用例\nTests  1 failed | 3 passed`;
    expect(classifyCommitFailure(raw)).toBe('test');
  });

  it('类型错误归类为 typecheck', () => {
    const raw = `src/index.ts:8:8 - error TS2503: Cannot find namespace 'cron'.`;
    expect(classifyCommitFailure(raw)).toBe('typecheck');
  });

  it('权限拒绝归类为 permission', () => {
    expect(classifyCommitFailure('remote: Permission to repo denied (403).')).toBe('permission');
  });

  it('非快进 push 归类为 push', () => {
    expect(classifyCommitFailure('! [rejected] feature -> feature (non-fast-forward)')).toBe('push');
  });

  it('无法识别归类为 unknown', () => {
    expect(classifyCommitFailure('一些完全无法识别的输出')).toBe('unknown');
  });
});

describe('distillCommitFailure', () => {
  it('几千行原文蒸馏为 ≤10 行，首行是归类，噪音被剔除', () => {
    const lintNoise = Array.from(
      { length: 800 },
      (_, i) => `  ${i}:26  warning  Forbidden non-null assertion`
    ).join('\n');
    const raw = `Worktree commit 失败:\n${lintNoise}\n❌ Commit message 不符合 Conventional Commits 规范。\n当前: 批量修复 1 个 Reviewer 问题`;
    const distilled = distillCommitFailure(raw);
    const lines = distilled.split('\n');
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines[0]).toContain('【提交失败分类: commit-message】');
    expect(distilled).toContain('批量修复 1 个 Reviewer 问题');
    expect(distilled).not.toContain('warning  Forbidden non-null assertion\n  100:');
  });
});

describe('detectCommitConvention', () => {
  it('commitlint.config.js 命中', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-conv-'));
    writeFileSync(join(dir, 'commitlint.config.js'), 'module.exports = {};');
    expect(detectCommitConvention(dir)).toContain('Conventional Commits');
  });

  it('package.json commitlint 键命中', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-conv-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ commitlint: { extends: [] } }));
    expect(detectCommitConvention(dir)).toContain('Conventional Commits');
  });

  it('.husky/commit-msg 命中', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-conv-'));
    mkdirSync(join(dir, '.husky'));
    writeFileSync(join(dir, '.husky', 'commit-msg'), 'npx commitlint --edit $1');
    expect(detectCommitConvention(dir)).toContain('Conventional Commits');
  });

  it('无任何配置时返回 undefined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-conv-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'plain' }));
    expect(detectCommitConvention(dir)).toBeUndefined();
  });
});

describe('合规默认提交信息（F2 第三级兜底）', () => {
  it('单 finding 默认信息具备合规形态', () => {
    const message = buildDefaultFixMessage({
      message: '变量未使用',
      ruleId: 'no-unused-vars',
      file: 'src/index.ts',
      line: 2,
    });
    expect(message.split('\n')[0]).toMatch(CONVENTIONAL);
    expect(message).toContain('变量未使用');
  });

  it('已具备合规形态的 subject 不重复加前缀', () => {
    const message = buildDefaultFixMessage({
      message: 'fix(api): 变量未使用',
      file: 'src/index.ts',
      line: 2,
    });
    expect(message.split('\n')[0]).toBe('fix(api): 变量未使用');
  });

  it('批量默认信息具备合规形态', () => {
    const message = buildDefaultBatchMessage(['src/a.ts'], ['docs/b.md']);
    expect(message.split('\n')[0]).toMatch(CONVENTIONAL);
    expect(message).toContain('批量修复 2 个 Reviewer 问题');
  });

  it('删除文件默认信息具备合规形态', () => {
    expect(buildDefaultDeleteMessage('telemetry-plan.md')).toMatch(CONVENTIONAL);
  });
});
