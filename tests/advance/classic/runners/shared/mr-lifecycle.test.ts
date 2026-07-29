import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archiveLifecycleRecord,
  buildMrLifecycleKey,
  classifyCiFailure,
  collectInterruptCandidates,
  computeClosureStats,
  createLifecycleState,
  detectInterruptCommand,
  extractFileCandidatesFromTrace,
  hashFailedJobs,
  isMrConverged,
  MAX_CI_FIX_ATTEMPTS_PER_HEAD,
  type MrLifecycleArchiveRecord,
} from '../../../../../src/advance/classic/runners/shared/mr-lifecycle.js';
import type { Discussion } from '../../../../../src/advance/classic/provider/types.js';

const alwaysHuman = () => true;
const agentIsNotHuman = (author: string) => author !== 'codekeeper-bot';

function makeDiscussion(overrides: Partial<Discussion>): Discussion {
  return {
    id: 'd-1',
    resolvable: true,
    resolved: false,
    notes: [],
    ...overrides,
  };
}

describe('buildMrLifecycleKey', () => {
  it('按 MR iid 生成稳定 key', () => {
    expect(buildMrLifecycleKey(42)).toBe('mr:42');
  });
});

describe('createLifecycleState', () => {
  it('初始化 active 状态与零值指标', () => {
    const lifecycle = createLifecycleState({
      iid: 7,
      title: 'feat: x',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      webUrl: 'https://gitlab.example.com/mr/7',
    });
    expect(lifecycle.status).toBe('active');
    expect(lifecycle.pollCount).toBe(0);
    expect(lifecycle.metrics.findingsFixed).toBe(0);
    expect(lifecycle.metrics.humanFollowupsAfterFix).toBe(0);
  });
});

describe('detectInterruptCommand', () => {
  const cases: Array<[string, string]> = [
    ['/ck stop', '斜杠命令'],
    ['/codekeeper stop', 'codekeeper 命令'],
    ['/maintainer pause', 'maintainer 命令'],
    ['@codekeeper stop 先别改了', 'mention 停止'],
    ['请停止自动修复这个 MR', '中文停止修复'],
    ['暂停自动维护', '中文暂停维护'],
    ['不要再自动提交了', '中文禁止提交'],
  ];

  it.each(cases)('识别人工中断指令：%s（%s）', body => {
    const interrupt = detectInterruptCommand(
      [{ author: 'dev', body, createdAt: '2026-07-29T10:00:00Z' }],
      alwaysHuman
    );
    expect(interrupt).toBeDefined();
    expect(interrupt?.by).toBe('dev');
  });

  it('忽略普通讨论内容', () => {
    const interrupt = detectInterruptCommand(
      [
        { author: 'dev', body: '这个函数先别改，我想想', createdAt: '2026-07-29T10:00:00Z' },
        { author: 'dev', body: '修复方案没问题', createdAt: '2026-07-29T10:01:00Z' },
      ],
      alwaysHuman
    );
    expect(interrupt).toBeUndefined();
  });

  it('忽略 Agent/bot 发布的停止指令', () => {
    const interrupt = detectInterruptCommand(
      [{ author: 'codekeeper-bot', body: '/ck stop', createdAt: '2026-07-29T10:00:00Z' }],
      agentIsNotHuman
    );
    expect(interrupt).toBeUndefined();
  });

  it('多条命中时取最新一条', () => {
    const interrupt = detectInterruptCommand(
      [
        { author: 'dev', body: '/ck stop', createdAt: '2026-07-29T10:00:00Z' },
        { author: 'lead', body: '停止自动修复', createdAt: '2026-07-29T12:00:00Z' },
      ],
      alwaysHuman
    );
    expect(interrupt?.by).toBe('lead');
  });
});

describe('computeClosureStats', () => {
  it('统计 resolvable discussion 的闭环率', () => {
    const stats = computeClosureStats([
      makeDiscussion({ id: 'a', resolved: true }),
      makeDiscussion({ id: 'b', resolved: false }),
      makeDiscussion({ id: 'c', resolved: true }),
    ]);
    expect(stats.total).toBe(3);
    expect(stats.resolved).toBe(2);
    expect(stats.closureRate).toBeCloseTo(2 / 3);
  });

  it('忽略非 resolvable discussion', () => {
    const stats = computeClosureStats([
      makeDiscussion({ id: 'a', resolvable: false, resolved: false }),
    ]);
    expect(stats.total).toBe(0);
    expect(stats.closureRate).toBe(1);
  });
});

describe('isMrConverged', () => {
  const closure = { total: 2, resolved: 2, closureRate: 1 };

  it('全部闭环且 CI 正常时判定收敛', () => {
    expect(isMrConverged({ pendingDiscussionCount: 0, closure, ciStatus: 'success' })).toBe(true);
  });

  it('存在待处理 discussion 时不收敛', () => {
    expect(isMrConverged({ pendingDiscussionCount: 1, closure, ciStatus: 'success' })).toBe(false);
  });

  it('存在未 resolve discussion 时不收敛', () => {
    expect(
      isMrConverged({
        pendingDiscussionCount: 0,
        closure: { total: 2, resolved: 1, closureRate: 0.5 },
        ciStatus: 'success',
      })
    ).toBe(false);
  });

  it('CI 失败或 CI 修复挂起时不收敛', () => {
    expect(isMrConverged({ pendingDiscussionCount: 0, closure, ciStatus: 'failed' })).toBe(false);
    expect(
      isMrConverged({ pendingDiscussionCount: 0, closure, ciStatus: 'success', ciSuspended: true })
    ).toBe(false);
  });
});

describe('classifyCiFailure', () => {
  it('script_failure 归类为代码问题（修）', () => {
    expect(classifyCiFailure({ failureReason: 'script_failure', traceTail: '' })).toBe('code');
  });

  it('runner/超时类失败归类为基础设施问题（挂起）', () => {
    expect(classifyCiFailure({ failureReason: 'runner_system_failure', traceTail: '' })).toBe(
      'infra'
    );
    expect(classifyCiFailure({ failureReason: 'stuck_or_timeout_failure', traceTail: '' })).toBe(
      'infra'
    );
  });

  it('无失败原因时按日志内容兜底判断', () => {
    expect(
      classifyCiFailure({ failureReason: undefined, traceTail: 'ERROR: no runner available' })
    ).toBe('infra');
    expect(classifyCiFailure({ failureReason: undefined, traceTail: 'jest: 2 tests failed' })).toBe(
      'unknown'
    );
  });
});

describe('hashFailedJobs', () => {
  it('同批 job 哈希稳定且与顺序无关', () => {
    const first = hashFailedJobs([
      { name: 'lint', stage: 'test' },
      { name: 'build', stage: 'build' },
    ]);
    const second = hashFailedJobs([
      { name: 'build', stage: 'build' },
      { name: 'lint', stage: 'test' },
    ]);
    expect(first).toBe(second);
  });

  it('job 集合变化时哈希变化', () => {
    const first = hashFailedJobs([{ name: 'lint', stage: 'test' }]);
    const second = hashFailedJobs([{ name: 'unit-test', stage: 'test' }]);
    expect(first).not.toBe(second);
  });
});

describe('extractFileCandidatesFromTrace', () => {
  it('从日志中提取仓库相对路径候选', () => {
    const trace = [
      'FAIL src/utils/parser.test.ts',
      '  at Object.<anonymous> (src/utils/parser.ts:42:11)',
      'error TS2304 in packages/core/src/index.ts:7',
    ].join('\n');
    const candidates = extractFileCandidatesFromTrace(trace);
    expect(candidates).toContain('src/utils/parser.test.ts');
    expect(candidates).toContain('src/utils/parser.ts');
    expect(candidates).toContain('packages/core/src/index.ts');
  });

  it('排除 node_modules 与 URL，且去重、限量', () => {
    const trace = [
      'at node_modules/react/index.js:1:1',
      'see https://example.com/docs/a.ts',
      'src/a.ts:1 src/a.ts:2 src/b.ts:3 src/c.ts:4 src/d.ts:5 src/e.ts:6',
    ].join('\n');
    const candidates = extractFileCandidatesFromTrace(trace, 5);
    expect(candidates.some(c => c.includes('node_modules'))).toBe(false);
    expect(candidates.some(c => c.startsWith('http'))).toBe(false);
    expect(candidates.length).toBeLessThanOrEqual(5);
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

describe('collectInterruptCandidates', () => {
  it('合并 MR 级评论与 discussion note', () => {
    const candidates = collectInterruptCandidates(
      [{ id: 1, author: 'dev', body: 'a', createdAt: '2026-07-29T00:00:00Z' }],
      [
        makeDiscussion({
          id: 'd-1',
          notes: [
            { id: 2, author: 'dev', body: 'b', createdAt: '2026-07-29T01:00:00Z' },
            { id: 3, author: 'dev', body: 'c', createdAt: '2026-07-29T02:00:00Z' },
          ],
        }),
      ]
    );
    expect(candidates.map(c => c.body)).toEqual(['a', 'b', 'c']);
  });
});

describe('archiveLifecycleRecord', () => {
  it('将生命周期记录写入归档目录并可读回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-lifecycle-'));
    try {
      const lifecycle = createLifecycleState({
        iid: 9,
        title: 'fix: y',
        sourceBranch: 'fix/y',
        targetBranch: 'main',
      });
      lifecycle.status = 'archived';
      lifecycle.endReason = 'merged';
      lifecycle.metrics.discussionsTotal = 10;
      lifecycle.metrics.discussionsResolved = 10;

      const closure = { total: 10, resolved: 10, closureRate: 1 };
      const filePath = archiveLifecycleRecord(dir, 'project-x', lifecycle, closure);

      expect(existsSync(filePath)).toBe(true);
      const record = JSON.parse(readFileSync(filePath, 'utf-8')) as MrLifecycleArchiveRecord;
      expect(record.version).toBe(1);
      expect(record.projectId).toBe('project-x');
      expect(record.lifecycle.mrIid).toBe(9);
      expect(record.lifecycle.endReason).toBe('merged');
      expect(record.closure.closureRate).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CI 修复配额', () => {
  it('单 head 最大修复尝试次数为 2', () => {
    expect(MAX_CI_FIX_ATTEMPTS_PER_HEAD).toBe(2);
  });
});
