import { describe, expect, it } from 'vitest';
import {
  selectRecentActiveComments,
  selectRecentActiveDiscussions,
} from '../../../../src/advance/classic/provider/activity-window.js';
import type {
  Discussion,
  ReviewerComment,
} from '../../../../src/advance/classic/provider/types.js';

function isoAt(minute: number): string {
  return new Date(Date.UTC(2026, 6, 1, 0, minute)).toISOString();
}

describe('远端活动窗口', () => {
  it('旧 discussion 出现新回复后应进入最近 100 条窗口', () => {
    const discussions: Discussion[] = Array.from({ length: 100 }, (_, index) => ({
      id: `discussion-${index + 1}`,
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: index + 1,
          author: 'reviewer',
          body: `virtual/module-${index + 1}.ts:1`,
          createdAt: isoAt(index + 1),
        },
      ],
    }));
    discussions.push({
      id: 'discussion-old-active',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1001,
          author: 'reviewer',
          body: 'virtual/module-old.ts:1',
          createdAt: isoAt(0),
        },
        {
          id: 1002,
          author: 'developer',
          body: '补充了新的处理信息',
          createdAt: isoAt(200),
        },
      ],
    });

    const active = selectRecentActiveDiscussions(discussions);

    expect(active).toHaveLength(100);
    expect(active.map(item => item.id)).toContain('discussion-old-active');
    expect(active.map(item => item.id)).not.toContain('discussion-1');
  });

  it('旧评论被编辑后应进入最近 100 条窗口', () => {
    const comments: ReviewerComment[] = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      author: 'developer',
      body: `评论 ${index + 1}`,
      createdAt: isoAt(index + 1),
    }));
    comments.push({
      id: 1001,
      author: 'developer',
      body: '编辑后的旧评论',
      createdAt: isoAt(0),
      updatedAt: isoAt(200),
    });

    const active = selectRecentActiveComments(comments);

    expect(active).toHaveLength(100);
    expect(active.map(item => item.id)).toContain(1001);
    expect(active.map(item => item.id)).not.toContain(1);
  });
});
