/**
 * maintainer-filter 单元测试
 */

import { describe, it, expect } from 'vitest';
import { isDiscussionPending, isJudgmentFlipped } from '../../../../../src/advance/classic/runners/shared/maintainer-filter.js';
import type { Discussion } from '../../../../../src/advance/classic/provider/types.js';
import type { MrAgentState, MaintainerFindingDecision } from '../../../../../src/advance/classic/runners/shared/state-utils.js';

function makeDiscussion(overrides: Partial<Discussion> = {}): Discussion {
  return {
    id: 'd-1',
    resolvable: true,
    resolved: false,
    notes: [{ author: 'reviewer', body: '有个问题', createdAt: '2026-01-01T00:00:00Z' }],
    ...overrides,
  };
}

function makeState(
  overrides: Partial<
    Pick<MrAgentState, 'interactiveThreads' | 'processedDiscussions' | 'maintainerThreadState'>
  > = {}
): Pick<MrAgentState, 'interactiveThreads' | 'processedDiscussions' | 'maintainerThreadState'> {
  return {
    interactiveThreads: {},
    processedDiscussions: {},
    maintainerThreadState: {},
    ...overrides,
  };
}

describe('isDiscussionPending', () => {
  it('未处理过的 discussion 默认进入流程', () => {
    const d = makeDiscussion();
    expect(isDiscussionPending(d, makeState())).toBe(true);
  });

  it('resolved 的 discussion 跳过', () => {
    const d = makeDiscussion({ resolved: true });
    expect(isDiscussionPending(d, makeState())).toBe(false);
  });

  it('不可 resolving 的 discussion 跳过', () => {
    const d = makeDiscussion({ resolvable: false });
    expect(isDiscussionPending(d, makeState())).toBe(false);
  });

  it('已处理且无新 note 的 discussion 跳过', () => {
    const d = makeDiscussion({
      notes: [
        { author: 'reviewer', body: 'a', createdAt: '2026-01-01T00:00:00Z' },
        {
          author: 'maintainer',
          body: '📝 已忽略\n\n---\n*生成于 2026/01/01 00:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-01-02T00:00:00Z',
        },
      ],
    });
    const state = makeState({
      processedDiscussions: { 'd-1': { noteCount: 2, processedAt: 1 } },
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'src/a.ts:1': { action: 'ignore', reason: '已忽略', failedAttempts: 0, decidedAt: 1 },
          },
          lastReviewerNoteAt: 0,
        },
      },
    });
    expect(isDiscussionPending(d, state)).toBe(false);
  });

  it('已处理但出现新 note 时重新进入流程', () => {
    const d = makeDiscussion({
      notes: [
        { author: 'reviewer', body: 'a', createdAt: '2026-01-01T00:00:00Z' },
        { author: 'reviewer', body: 'b', createdAt: '2026-01-02T00:00:00Z' },
      ],
    });
    const state = makeState({ processedDiscussions: { 'd-1': { noteCount: 1, processedAt: 1 } } });
    expect(isDiscussionPending(d, state)).toBe(true);
  });

  it('首条 Reviewer note 被编辑后即使 note 数未变也重新进入流程', () => {
    const previousActivityAt = Date.parse('2026-07-01T00:00:00.000Z');
    const updatedAt = Date.parse('2026-07-02T00:00:00.000Z');
    const d = makeDiscussion({
      notes: [
        {
          id: 1,
          author: 'reviewer-bot',
          body: 'virtual/module-a.ts:10 更新后的问题描述',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-02T00:00:00.000Z',
        },
        {
          id: 2,
          author: 'maintainer-bot',
          body: '✅ 已处理\n\n---\n*生成于 2026/07/01 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-07-01T01:00:00.000Z',
        },
      ],
    });
    const state = makeState({
      processedDiscussions: {
        'd-1': { noteCount: 2, processedAt: previousActivityAt },
      },
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'virtual/module-a.ts:10': {
              action: 'ignore',
              reason: '旧结论',
              failedAttempts: 0,
              decidedAt: previousActivityAt,
            },
          },
          lastReviewerNoteAt: previousActivityAt,
        },
      },
    });

    expect(updatedAt).toBeGreaterThan(previousActivityAt);
    expect(isDiscussionPending(d, state)).toBe(true);
  });

  it('交互式等待中且无新人工回复时不再每轮进入流程', () => {
    const now = Date.now();
    const d = makeDiscussion({
      notes: [
        {
          author: 'human',
          body: '这里要怎么改？',
          createdAt: new Date(now - 60_000).toISOString(),
        },
        {
          author: 'maintainer',
          body: '能否补充一下期望？\n\n---\n*生成于 2026/01/01 00:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: new Date(now - 30_000).toISOString(),
        },
      ],
    });
    const state = makeState({
      interactiveThreads: {
        'd-1': {
          status: 'awaiting-reply',
          askedAt: now - 30_000,
          question: '能否补充？',
          filePath: 'a.ts',
        },
      },
      processedDiscussions: { 'd-1': { noteCount: 2, processedAt: now - 30_000 } },
    });
    expect(isDiscussionPending(d, state)).toBe(false);
  });

  it('交互式等待中出现新人工回复时进入流程', () => {
    const now = Date.now();
    const d = makeDiscussion({
      notes: [
        {
          author: 'human',
          body: '这里要怎么改？',
          createdAt: new Date(now - 60_000).toISOString(),
        },
        {
          author: 'maintainer',
          body: '能否补充一下期望？\n\n---\n*生成于 2026/01/01 00:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: new Date(now - 30_000).toISOString(),
        },
        { author: 'human', body: '按方案 A 改', createdAt: new Date(now - 10_000).toISOString() },
      ],
    });
    const state = makeState({
      interactiveThreads: {
        'd-1': {
          status: 'awaiting-reply',
          askedAt: now - 30_000,
          question: '能否补充？',
          filePath: 'a.ts',
        },
      },
      processedDiscussions: { 'd-1': { noteCount: 2, processedAt: now - 30_000 } },
    });
    expect(isDiscussionPending(d, state)).toBe(true);
  });

  it('交互式提问 note 被人工删除时进入流程清理脏状态', () => {
    const now = Date.now();
    const d = makeDiscussion({
      notes: [
        // 只剩人工 note，Maintainer 的提问 note 已被删除
        {
          author: 'human',
          body: '这里为什么要这么改？',
          createdAt: new Date(now - 60_000).toISOString(),
        },
      ],
    });
    const state = makeState({
      interactiveThreads: {
        'd-1': {
          status: 'awaiting-reply',
          askedAt: now - 30_000,
          question: '能否补充？',
          filePath: 'a.ts',
        },
      },
      processedDiscussions: { 'd-1': { noteCount: 2, processedAt: now - 30_000 } },
    });
    expect(isDiscussionPending(d, state)).toBe(true);
  });

  it('交互式等待超时后进入流程以便收尾', () => {
    const d = makeDiscussion();
    const state = makeState({
      interactiveThreads: {
        // askedAt 极早，必然超过 3 天超时
        'd-1': { status: 'awaiting-reply', askedAt: 1, question: '请问？', filePath: 'a.ts' },
      },
      processedDiscussions: { 'd-1': { noteCount: 2, processedAt: 1 } },
    });
    expect(isDiscussionPending(d, state)).toBe(true);
  });

  it('已处理过但没有任何 Maintainer 痕迹时允许重试', () => {
    const d = makeDiscussion({
      notes: [{ author: 'reviewer', body: '有个问题', createdAt: '2026-01-01T00:00:00Z' }],
    });
    const state = makeState({ processedDiscussions: { 'd-1': { noteCount: 1, processedAt: 1 } } });
    expect(isDiscussionPending(d, state)).toBe(true);
  });

  it('已处理过但无处理证据（空 threadState）时放行重新评估', () => {
    // 旧版本走了 non-finding 路径，只记了 noteCount，没留任何决策记录，
    // 不能因为「处理过」就永久压住真实 finding
    const d = makeDiscussion({
      notes: [{ author: 'ci-bot', body: 'CI Review 报告', createdAt: '2026-01-01T00:00:00Z' }],
    });
    const state = makeState({
      processedDiscussions: { 'd-1': { noteCount: 1, processedAt: 1 } },
      maintainerThreadState: {
        'd-1': { decisions: {}, lastReviewerNoteAt: 0 },
      },
    });
    expect(isDiscussionPending(d, state)).toBe(true);
  });

  it('已处理且有非 finding 处理记录时跳过', () => {
    const d = makeDiscussion({
      notes: [{ author: 'ci-bot', body: 'CI Review 报告', createdAt: '2026-01-01T00:00:00Z' }],
    });
    const state = makeState({
      processedDiscussions: { 'd-1': { noteCount: 1, processedAt: 1 } },
      maintainerThreadState: {
        'd-1': { decisions: {}, lastReviewerNoteAt: 0, nonFindingAction: 'record' },
      },
    });
    expect(isDiscussionPending(d, state)).toBe(false);
  });

  it('CI bot 作者的 note 不算人工回复，不触发重评估', () => {
    // Maintainer 已回复后，CI bot 的重扫 note 不算人工新回复，不应重新处理
    const d = makeDiscussion({
      notes: [
        { author: 'reviewer', body: '有个问题', createdAt: '2026-01-01T00:00:00Z' },
        {
          author: 'maintainer',
          body: '✅ 已处理\n\n---\n*生成于 2026/01/01 01:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-01-01T01:00:00Z',
        },
        {
          author: 'project_193142_bot_63ebd35e8f3b9293ee769e43fa413e1e',
          body: 'CI Review 重扫报告',
          createdAt: '2026-01-01T02:00:00Z',
        },
      ],
    });
    const state = makeState({
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'src/a.ts:1': { action: 'ignore', reason: '已处理', failedAttempts: 0, decidedAt: 1 },
          },
          lastReviewerNoteAt: 0,
        },
      },
    });
    expect(isDiscussionPending(d, state)).toBe(false);
  });

  it('存在 Maintainer 最终回复且有处理证据时跳过', () => {
    const d = makeDiscussion({
      notes: [
        { author: 'reviewer', body: 'a', createdAt: '2026-01-01T00:00:00Z' },
        {
          author: 'maintainer',
          body: '✅ 已修复\n\n---\n*生成于 2026/01/01 00:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-01-02T00:00:00Z',
        },
      ],
    });
    const state = makeState({
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'src/a.ts:1': {
              action: 'ignore',
              alreadyFixed: true,
              reason: '已修复',
              failedAttempts: 0,
              decidedAt: 1,
            },
          },
          lastReviewerNoteAt: 0,
        },
      },
    });
    expect(isDiscussionPending(d, state)).toBe(false);
  });

  it('全部无需修复但远端最终说明被删除时重新进入流程', () => {
    const d = makeDiscussion({
      notes: [{ author: 'reviewer-bot', body: '发现两个问题', createdAt: '2026-07-20T00:00:00Z' }],
    });
    const state = makeState({
      processedDiscussions: { 'd-1': { noteCount: 2, processedAt: 1 } },
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'src/app.ts:10': {
              action: 'ignore',
              alreadyFixed: true,
              reason: '当前实现已满足要求',
              failedAttempts: 0,
              decidedAt: 1,
            },
            'src/facade.ts:20': {
              action: 'ignore',
              reason: '该项无需修改',
              failedAttempts: 0,
              decidedAt: 1,
            },
          },
          lastReviewerNoteAt: 0,
          lastSummaryHash: 'old-summary',
        },
      },
    });

    expect(isDiscussionPending(d, state)).toBe(true);
  });

  it('有 Maintainer 回复但无任何处理记录时放行重新评估', () => {
    // 旧版本对含真实 finding 的评论只发过轻松回复，未记录任何决策，
    // 不能因为有一条 Maintainer note 就永久跳过
    const d = makeDiscussion({
      notes: [
        {
          author: 'reviewer-bot',
          body: 'CI Review 报告（含 finding 表格）',
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          author: 'maintainer',
          body: '感谢 Review 的详细分析！\n\n---\n*生成于 2026/01/01 01:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-01-01T01:00:00Z',
        },
      ],
    });
    expect(isDiscussionPending(d, makeState())).toBe(true);
  });

  it('有 Maintainer 回复且有非 finding 处理记录时跳过', () => {
    const d = makeDiscussion({
      notes: [
        { author: 'reviewer-bot', body: '普通汇总评论', createdAt: '2026-01-01T00:00:00Z' },
        {
          author: 'maintainer',
          body: '感谢确认\n\n---\n*生成于 2026/01/01 01:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-01-01T01:00:00Z',
        },
      ],
    });
    const state = makeState({
      maintainerThreadState: {
        'd-1': {
          decisions: {},
          lastReviewerNoteAt: 0,
          nonFindingAction: 'ignore',
        },
      },
    });
    expect(isDiscussionPending(d, state)).toBe(false);
  });

  it('最后一条 Maintainer note 是提问且无人工回复时跳过', () => {
    const now = Date.now();
    const d = makeDiscussion({
      notes: [
        { author: 'reviewer', body: 'a', createdAt: new Date(now - 120_000).toISOString() },
        {
          author: 'maintainer',
          body: '能否补充一下期望？\n\n---\n*生成于 2026/01/01 00:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: new Date(now - 60_000).toISOString(),
        },
      ],
    });
    // 现行代码提问时会登记交互等待状态，等待期间由交互分支静默处理
    const state = makeState({
      interactiveThreads: {
        'd-1': {
          status: 'awaiting-reply',
          askedAt: now - 60_000,
          question: '能否补充一下期望？',
          filePath: 'a.ts',
        },
      },
    });
    expect(isDiscussionPending(d, state)).toBe(false);
  });

  it('提问后有人工回复时进入流程', () => {
    const d = makeDiscussion({
      notes: [
        { author: 'reviewer', body: 'a', createdAt: '2026-01-01T00:00:00Z' },
        {
          author: 'maintainer',
          body: '能否补充一下期望？\n\n---\n*生成于 2026/01/01 00:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-01-02T00:00:00Z',
        },
        { author: 'human', body: '补充说明', createdAt: '2026-01-03T00:00:00Z' },
      ],
    });
    expect(isDiscussionPending(d, makeState())).toBe(true);
  });

  it('Reviewer bot 发的原始 finding 未回复时进入流程', () => {
    const d = makeDiscussion({
      notes: [
        {
          author: 'reviewer-bot',
          body: 'src/a.ts:1 变量未使用\n\n---\n*生成于 2026/01/01 · CodeKeeper Advance MR 评审 Agent · bot*',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    expect(isDiscussionPending(d, makeState())).toBe(true);
  });

  it('Reviewer bot 的 finding 已被 Maintainer 回复且有处理证据后跳过', () => {
    const d = makeDiscussion({
      notes: [
        {
          author: 'reviewer-bot',
          body: 'src/a.ts:1 变量未使用\n\n---\n*生成于 2026/01/01 · CodeKeeper Advance MR 评审 Agent · bot*',
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          author: 'maintainer',
          body: '✅ 已修复\n\n---\n*生成于 2026/01/02 00:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-01-02T00:00:00Z',
        },
      ],
    });
    const state = makeState({
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'src/a.ts:1': {
              action: 'fix',
              reason: '已删除',
              failedAttempts: 0,
              fixSucceeded: true,
              decidedAt: 1,
            },
          },
          lastReviewerNoteAt: 0,
        },
      },
    });
    expect(isDiscussionPending(d, state)).toBe(false);
  });

  it('有具体 file:line 但尚无 Maintainer 回复时不被旧状态压过', () => {
    const d = makeDiscussion({
      notes: [
        {
          author: 'reviewer-bot',
          body: 'packages/example-core/src/parser.ts:22 存在类型问题',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const state = makeState({
      processedDiscussions: { 'd-1': { noteCount: 1, processedAt: 1 } },
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'packages/example-core/src/parser.ts:22': {
              action: 'fix',
              reason: '历史修复尝试未成功',
              failedAttempts: 3,
              decidedAt: 1,
            },
          },
          lastReviewerNoteAt: 0,
        },
      },
    });

    expect(isDiscussionPending(d, state)).toBe(true);
  });

  it('存在失败且未达重试上限的 fix 时，即使最后一条是 Maintainer 最终回复也进入流程', () => {
    const d = makeDiscussion({
      notes: [
        { author: 'reviewer', body: 'a', createdAt: '2026-01-01T00:00:00Z' },
        {
          author: 'maintainer',
          body: '✅ 已修复\n\n---\n*生成于 2026/01/01 00:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-01-02T00:00:00Z',
        },
      ],
    });
    const state = makeState({
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'src/a.ts:1': {
              action: 'fix',
              reason: '修复失败',
              failedAttempts: 1,
              decidedAt: 1,
            },
          },
          lastReviewerNoteAt: 0,
        },
      },
    });
    expect(isDiscussionPending(d, state)).toBe(true);
  });

  it('失败 fix 已达重试上限时不再进入流程', () => {
    const d = makeDiscussion({
      notes: [
        { author: 'reviewer', body: 'a', createdAt: '2026-01-01T00:00:00Z' },
        {
          author: 'maintainer',
          body: '✅ 已修复\n\n---\n*生成于 2026/01/01 00:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-01-02T00:00:00Z',
        },
      ],
    });
    const state = makeState({
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'src/a.ts:1': {
              action: 'fix',
              reason: '修复失败',
              failedAttempts: 3,
              decidedAt: 1,
            },
          },
          lastReviewerNoteAt: 0,
        },
      },
    });
    expect(isDiscussionPending(d, state)).toBe(false);
  });

  it('历史孤儿失败决策不再触发当前 discussion 重试', () => {
    const d = makeDiscussion({
      notes: [
        {
          author: 'reviewer',
          body: 'modules/example-a/src/parser.ts:20 存在问题',
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          author: 'maintainer',
          body: '✅ 已修复\n\n---\n*生成于 2026/01/02 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-01-02T00:00:00Z',
        },
      ],
    });
    const state = makeState({
      processedDiscussions: { 'd-1': { noteCount: 2, processedAt: 2 } },
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'modules/example-a/src/parser.ts:20': {
              action: 'fix',
              reason: '已修复',
              failedAttempts: 0,
              fixSucceeded: true,
              decidedAt: 2,
            },
            '/ci/builds/group/sample-repo/modules/example-a/src/parser.ts:20': {
              action: 'fix',
              reason: '旧路径下修复失败',
              failedAttempts: 1,
              decidedAt: 1,
            },
          },
          activeFindingKeys: ['modules/example-a/src/parser.ts:20'],
          lastReviewerNoteAt: Date.parse('2026-01-01T00:00:00Z'),
        },
      },
    });

    expect(isDiscussionPending(d, state)).toBe(false);
  });

  it('resolved 的 discussion 不因缺少无需修复说明而复活补发', () => {
    // F1：人类已 resolve 的 thread 已闭环，「补发说明」不足以复活它制造噪音评论
    const d = makeDiscussion({
      resolved: true,
      notes: [
        { author: 'reviewer', body: 'src/a.ts:1 与 src/b.ts:2 都有问题', createdAt: '2026-01-01T00:00:00Z' },
      ],
    });
    const state = makeState({
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'src/a.ts:1': { action: 'ignore', alreadyFixed: true, reason: '已修复', failedAttempts: 0, decidedAt: 1 },
            'src/b.ts:2': { action: 'ignore', reason: '无需修改', failedAttempts: 0, decidedAt: 1 },
          },
          lastReviewerNoteAt: 0,
        },
      },
    });
    expect(isDiscussionPending(d, state)).toBe(false);
  });

  it('未 resolved 且缺少无需修复说明时仍进入流程补发', () => {
    // 与上一用例对照：未 resolved 时补发逻辑保持原有行为
    const d = makeDiscussion({
      notes: [
        { author: 'reviewer', body: 'src/a.ts:1 与 src/b.ts:2 都有问题', createdAt: '2026-01-01T00:00:00Z' },
      ],
    });
    const state = makeState({
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'src/a.ts:1': { action: 'ignore', alreadyFixed: true, reason: '已修复', failedAttempts: 0, decidedAt: 1 },
            'src/b.ts:2': { action: 'ignore', reason: '无需修改', failedAttempts: 0, decidedAt: 1 },
          },
          lastReviewerNoteAt: 0,
        },
      },
    });
    expect(isDiscussionPending(d, state)).toBe(true);
  });

  it('无需修复说明补发过一次后熔断，不因行号漂移反复补发', () => {
    // F4：补发过一次后，远端说明逐条 file:line 匹配仍失败（行号漂移）也不再重复补发
    const backfilledAt = Date.parse('2026-01-03T00:00:00Z');
    const d = makeDiscussion({
      notes: [
        { author: 'reviewer', body: 'src/a.ts:1 与 src/b.ts:2 都有问题', createdAt: '2026-01-01T00:00:00Z' },
        {
          author: 'maintainer',
          // 说明中只提到 src/a.ts:1（src/b.ts:2 因行号漂移匹配不上）
          body: '✅ 已修复（无需重复修改）：\n- src/a.ts:1: 已满足要求\n\n---\n*生成于 2026/01/03 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-01-03T00:00:00Z',
        },
      ],
    });
    const state = makeState({
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'src/a.ts:1': { action: 'ignore', alreadyFixed: true, reason: '已修复', failedAttempts: 0, decidedAt: 1 },
            'src/b.ts:2': { action: 'ignore', reason: '无需修改', failedAttempts: 0, decidedAt: 1 },
          },
          lastReviewerNoteAt: 0,
          noFixExplanationBackfilledAt: backfilledAt,
        },
      },
    });
    expect(isDiscussionPending(d, state)).toBe(false);
  });

  it('补发熔断后出现新人工回复时解除熔断重新进入流程', () => {
    const backfilledAt = Date.parse('2026-01-03T00:00:00Z');
    const d = makeDiscussion({
      notes: [
        { author: 'reviewer', body: 'src/a.ts:1 与 src/b.ts:2 都有问题', createdAt: '2026-01-01T00:00:00Z' },
        {
          author: 'maintainer',
          body: '✅ 已修复（无需重复修改）：\n- src/a.ts:1: 已满足要求\n\n---\n*生成于 2026/01/03 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-01-03T00:00:00Z',
        },
        { author: 'reviewer', body: 'src/b.ts:2 的说明在哪里？', createdAt: '2026-01-04T00:00:00Z' },
      ],
    });
    const state = makeState({
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'src/a.ts:1': { action: 'ignore', alreadyFixed: true, reason: '已修复', failedAttempts: 0, decidedAt: 1 },
            'src/b.ts:2': { action: 'ignore', reason: '无需修改', failedAttempts: 0, decidedAt: 1 },
          },
          lastReviewerNoteAt: 0,
          noFixExplanationBackfilledAt: backfilledAt,
        },
      },
    });
    expect(isDiscussionPending(d, state)).toBe(true);
  });
});

describe('isJudgmentFlipped（M7 推翻判定）', () => {
  const ignoreDecision: MaintainerFindingDecision = {
    action: 'ignore',
    reason: '此前判断无需修复',
    failedAttempts: 0,
    decidedAt: 1,
  };

  it('ignore + 新人工回复 + 新决策 fix → 判定为推翻', () => {
    expect(isJudgmentFlipped(ignoreDecision, true, 'fix')).toBe(true);
  });

  it('alreadyFixed 的 ignore 被推翻同样成立', () => {
    expect(isJudgmentFlipped({ ...ignoreDecision, alreadyFixed: true }, true, 'fix')).toBe(true);
  });

  it('无新人工回复不判定为推翻（Agent 自动重扫不带新信息）', () => {
    expect(isJudgmentFlipped(ignoreDecision, false, 'fix')).toBe(false);
  });

  it('此前是 fix 决策不算推翻', () => {
    const fixDecision: MaintainerFindingDecision = {
      action: 'fix',
      reason: '此前修复失败',
      failedAttempts: 1,
      decidedAt: 1,
    };
    expect(isJudgmentFlipped(fixDecision, true, 'fix')).toBe(false);
  });

  it('新决策仍是 ignore/ask 不算推翻', () => {
    expect(isJudgmentFlipped(ignoreDecision, true, 'ignore')).toBe(false);
    expect(isJudgmentFlipped(ignoreDecision, true, 'ask')).toBe(false);
  });

  it('无历史决策不算推翻', () => {
    expect(isJudgmentFlipped(undefined, true, 'fix')).toBe(false);
  });
});
