/**
 * MR 评审范围过滤单元测试
 */

import { describe, it, expect } from 'vitest';
import { matchesFilter } from '../../../../src/advance/classic/provider/mr-filter.js';
import type { MergeRequest } from '../../../../src/advance/classic/provider/types.js';

function makeMr(partial: Partial<MergeRequest> = {}): MergeRequest {
  return {
    iid: 1,
    title: 'Test MR',
    description: '',
    sourceBranch: 'feature',
    targetBranch: 'main',
    author: 'alice',
    draft: false,
    changesCount: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    webUrl: 'https://example.com/mr/1',
    assignee: 'bob',
    reviewers: ['carol'],
    labels: ['bug'],
    ...partial,
  };
}

describe('matchesFilter', () => {
  it('filter 为空或未配置时返回 true', () => {
    expect(matchesFilter(makeMr(), undefined)).toBe(true);
    expect(matchesFilter(makeMr(), { conditions: [] })).toBe(true);
  });

  it('单字段单值过滤正确', () => {
    const mr = makeMr({ author: 'alice' });
    expect(matchesFilter(mr, { conditions: [{ field: 'author', values: ['alice'] }] })).toBe(true);
    expect(matchesFilter(mr, { conditions: [{ field: 'author', values: ['bob'] }] })).toBe(false);
  });

  it('同字段多值按 OR 过滤', () => {
    const mr = makeMr({ author: 'alice' });
    expect(matchesFilter(mr, { conditions: [{ field: 'author', values: ['alice', 'bob'] }] })).toBe(true);
    expect(matchesFilter(mr, { conditions: [{ field: 'author', values: ['bob', 'carol'] }] })).toBe(false);
  });

  it('多字段按 AND 过滤', () => {
    const mr = makeMr({ author: 'alice', labels: ['bug'] });
    expect(matchesFilter(mr, {
      conditions: [
        { field: 'author', values: ['alice'] },
        { field: 'label', values: ['bug'] },
      ],
    })).toBe(true);
    expect(matchesFilter(mr, {
      conditions: [
        { field: 'author', values: ['alice'] },
        { field: 'label', values: ['feature'] },
      ],
    })).toBe(false);
  });

  it('reviewer 字段本地过滤', () => {
    const mr = makeMr({ reviewers: ['alice', 'carol'] });
    expect(matchesFilter(mr, { conditions: [{ field: 'reviewer', values: ['alice'] }] })).toBe(true);
    expect(matchesFilter(mr, { conditions: [{ field: 'reviewer', values: ['bob'] }] })).toBe(false);
  });

  it('label 字段本地过滤', () => {
    const mr = makeMr({ labels: ['bug', 'backend'] });
    expect(matchesFilter(mr, { conditions: [{ field: 'label', values: ['bug'] }] })).toBe(true);
    expect(matchesFilter(mr, { conditions: [{ field: 'label', values: ['frontend'] }] })).toBe(false);
  });

  it('draft 字段本地过滤', () => {
    const mr = makeMr({ draft: true });
    expect(matchesFilter(mr, { conditions: [{ field: 'draft', values: ['true'] }] })).toBe(true);
    expect(matchesFilter(mr, { conditions: [{ field: 'draft', values: ['false'] }] })).toBe(false);
  });

  it('空值条件被忽略', () => {
    const mr = makeMr({ author: 'alice' });
    expect(matchesFilter(mr, {
      conditions: [
        { field: 'author', values: [''] },
        { field: 'label', values: [''] },
      ],
    })).toBe(true);
  });
});
