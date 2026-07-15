/**
 * maintainer-filter 单元测试
 */

import { describe, it, expect } from 'vitest';
import { isDiscussionPending } from '../../../../../src/advance/classic/runners/shared/maintainer-filter.js';
import type { Discussion } from '../../../../../src/advance/classic/provider/types.js';
import type { MrAgentState } from '../../../../../src/advance/classic/runners/shared/state-utils.js';

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
  overrides: Partial<Pick<MrAgentState, 'interactiveThreads' | 'processedDiscussions' | 'maintainerThreadState'>> = {}
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
    const state = makeState({ processedDiscussions: { 'd-1': { noteCount: 2, processedAt: 1 } } });
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

  it('交互式等待中的 discussion 进入流程', () => {
    const d = makeDiscussion();
    const state = makeState({
      interactiveThreads: {
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

  it('存在 Maintainer 最终回复时跳过', () => {
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
    expect(isDiscussionPending(d, makeState())).toBe(false);
  });

  it('最后一条 Maintainer note 是提问时进入流程', () => {
    const d = makeDiscussion({
      notes: [
        { author: 'reviewer', body: 'a', createdAt: '2026-01-01T00:00:00Z' },
        {
          author: 'maintainer',
          body: '能否补充一下期望？\n\n---\n*生成于 2026/01/01 00:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-01-02T00:00:00Z',
        },
      ],
    });
    expect(isDiscussionPending(d, makeState())).toBe(true);
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
});
