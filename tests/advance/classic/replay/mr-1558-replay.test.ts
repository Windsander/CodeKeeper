/**
 * G2：MR !1558 真实快照回放 harness
 *
 * 数据来源：tests/fixtures/mr-1558/discussions.json
 * 由 .tmp-mr-analysis/extract_fixture.py 从 GitLab 页面快照（2026-07-30 抓取）提取，
 * 快照本身体积过大不入库；fixture 保留了全部 25 条讨论的评论时间线。
 *
 * 该 MR 曾暴露三类 Maintainer 失控模式，本 harness 用真实评论正文做回归断言：
 * 1. 重复评论：已发过「✅ 已修复」的 discussion 被再次补发 already-fixed 说明
 *    （190140ab / ac669e74 的第二条 maintainer note）；
 * 2. 修复失败提问：fix 失败后向 Reviewer 索要修改方式（8dbe20a5）；
 * 3. 陈旧 pending 投递重试：7-27 生成的说明 7-30 才被补投（190140ab note 2 时间差）。
 *
 * 断言分两层：
 * - 分类层：真实 note 正文必须被署名/已修复说明识别函数正确归类（熔断机制的前置条件）；
 * - 过滤层：基线状态回放 isDiscussionPending，已闭环讨论不得复活、补发熔断必须生效。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Discussion, ReviewerComment } from '../../../../src/advance/classic/provider/types.js';
import type {
  MaintainerThreadState,
  MrAgentState,
} from '../../../../src/advance/classic/runners/shared/state-utils.js';
import {
  isDiscussionPending,
  isNoFixBackfillCapped,
} from '../../../../src/advance/classic/runners/shared/maintainer-filter.js';
import {
  isMaintainerAuthoredNote,
  isMaintainerNoFixExplanationNote,
} from '../../../../src/advance/classic/runners/shared/review-utils.js';

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/mr-1558/discussions.json'
);

interface FixtureNote {
  noteId: string;
  author: string;
  authorKind: 'bot' | 'human';
  kind: 'review-agent' | 'maintainer-agent' | 'system' | 'comment';
  at: string | null;
  body: string;
}

interface FixtureDiscussion {
  discussionId: string;
  resolvable: boolean;
  resolved: boolean;
  notes: FixtureNote[];
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as FixtureDiscussion[];
const byId = new Map(fixture.map(d => [d.discussionId.slice(0, 8), d]));

function toDiscussion(d: FixtureDiscussion): Discussion {
  const notes: ReviewerComment[] = d.notes.map(n => ({
    id: Number(n.noteId),
    author: n.author,
    body: n.body,
    createdAt: n.at ?? '',
    updatedAt: n.at ?? undefined,
  }));
  return { id: d.discussionId, resolvable: d.resolvable, resolved: d.resolved, notes };
}

function lastNoteAt(d: FixtureDiscussion): number {
  return d.notes.reduce((max, n) => Math.max(max, n.at ? Date.parse(n.at) : 0), 0);
}

/** 基线状态：最后一轮轮询已在所有评论之后完成 */
function baselinedState(d: FixtureDiscussion): Pick<
  MrAgentState,
  'interactiveThreads' | 'processedDiscussions' | 'maintainerThreadState'
> {
  return {
    interactiveThreads: {},
    processedDiscussions: {
      [d.discussionId]: { noteCount: d.notes.length, processedAt: lastNoteAt(d) + 1000 },
    },
    maintainerThreadState: {},
  };
}

describe('MR !1558 fixture 完整性', () => {
  it('覆盖 25 条讨论与关键失控场景', () => {
    expect(fixture).toHaveLength(25);
    // 重复 already-fixed 补发的两条讨论
    expect(byId.get('190140ab')?.notes.filter(n => n.kind === 'maintainer-agent')).toHaveLength(2);
    expect(byId.get('ac669e74')?.notes.filter(n => n.kind === 'maintainer-agent')).toHaveLength(2);
    // 修复失败向 Reviewer 索要修改方式的讨论
    expect(byId.get('8dbe20a5')?.notes.some(n => n.body.includes('未成功'))).toBe(true);
  });
});

describe('真实评论正文的分类识别', () => {
  it('所有 maintainer-agent 评论都被署名识别（自我评论不触发再处理）', () => {
    const maintainerNotes = fixture.flatMap(d =>
      d.notes.filter(n => n.kind === 'maintainer-agent')
    );
    expect(maintainerNotes.length).toBeGreaterThanOrEqual(8);
    for (const note of maintainerNotes) {
      expect(isMaintainerAuthoredNote(note.body)).toBe(true);
    }
  });

  it('already-fixed 补发说明被识别为最终说明（补发熔断可生效）', () => {
    for (const [key, noteIdx] of [
      ['190140ab', 2],
      ['ac669e74', 2],
      ['ea4d32a4', 1],
    ] as const) {
      const note = byId.get(key)!.notes[noteIdx];
      expect(isMaintainerNoFixExplanationNote(note.body)).toBe(true);
    }
  });

  it('修复失败提问评论被识别为 Maintainer 自述而非人工输入', () => {
    const note = byId.get('8dbe20a5')!.notes[1];
    expect(note.body).toContain('未成功');
    expect(isMaintainerAuthoredNote(note.body)).toBe(true);
  });
});

describe('过滤层回放：闭环讨论不复活', () => {
  it('所有已 resolved 讨论在基线状态下均不 pending（不会再发任何评论）', () => {
    const resolved = fixture.filter(d => d.resolved);
    expect(resolved.length).toBeGreaterThanOrEqual(15);
    for (const d of resolved) {
      expect(isDiscussionPending(toDiscussion(d), baselinedState(d))).toBe(false);
    }
  });

  it('190140ab：已修复 + 已补发的讨论即使未 resolved，也被补发熔断压住', () => {
    const d = byId.get('190140ab')!;
    const discussion = { ...toDiscussion(d), resolved: false };
    const backfilledAt = Date.parse(d.notes[2].at!);
    const threadState: MaintainerThreadState = {
      decisions: {
        // 行号漂移场景：note 正文匹配不到该 fileLine，识别不完整
        'docs/internal/plans/2026-06-24-memory-telemetry-plan.md:99': {
          action: 'ignore',
          alreadyFixed: true,
          reason: '文件已删除',
          failedAttempts: 0,
          decidedAt: Date.parse(d.notes[1].at!),
        },
      },
      lastReviewerNoteAt: Date.parse(d.notes[0].at!),
      noFixExplanationBackfilledAt: backfilledAt,
    };
    const lastHumanNoteAt = Date.parse(d.notes[0].at!);

    expect(isNoFixBackfillCapped(threadState, lastHumanNoteAt)).toBe(true);
    const state = {
      ...baselinedState(d),
      maintainerThreadState: { [d.discussionId]: threadState },
    };
    expect(isDiscussionPending(discussion, state)).toBe(false);
  });

  it('补发后出现新人工回复时熔断解除（允许重新评估）', () => {
    const d = byId.get('ac669e74')!;
    const backfilledAt = Date.parse(d.notes[2].at!);
    const threadState: MaintainerThreadState = {
      decisions: {
        'docs/internal/specs/2026-06-24-memory-telemetry-design.md:1': {
          action: 'ignore',
          alreadyFixed: true,
          reason: '文件已删除',
          failedAttempts: 0,
          decidedAt: Date.parse(d.notes[1].at!),
        },
      },
      lastReviewerNoteAt: Date.parse(d.notes[0].at!),
      noFixExplanationBackfilledAt: backfilledAt,
    };
    const newHumanReplyAt = backfilledAt + 60_000;

    expect(isNoFixBackfillCapped(threadState, newHumanReplyAt)).toBe(false);
  });
});
