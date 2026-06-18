import { describe, it, expect } from 'vitest';
import { formatReviewComment } from '../../../src/advance/classic/mr-agent-entry.js';
import type { MergeRequest, ReviewResult } from '../../../src/advance/classic/provider/types.js';

const mockMR: MergeRequest = {
  iid: 1,
  title: 'Add login feature',
  description: 'Implement user login',
  sourceBranch: 'feature/login',
  targetBranch: 'main',
  author: 'alice',
  draft: false,
  changesCount: 3,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  webUrl: 'https://example.com/mr/1',
};

const mockResult: ReviewResult = {
  findings: [
    {
      severity: 'HIGH',
      file: 'src/auth.ts',
      line: 42,
      ruleId: 'AUTH-001',
      message: '密码以明文形式传输',
      suggestion: '使用 HTTPS 并对敏感字段加密',
      autoFixable: false,
    },
    {
      severity: 'LOW',
      file: 'src/utils.ts',
      line: 7,
      message: '缺少空值检查',
      suggestion: '添加可选链或默认值',
      autoFixable: true,
    },
  ],
  summary: '发现 2 个问题，建议优先处理 HIGH 级别项。',
  autoFixable: [1],
};

describe('formatReviewComment', () => {
  it('包含 MR 元信息表格', () => {
    const comment = formatReviewComment(mockMR, { ...mockResult, findings: [] });
    expect(comment).toContain('## 🤖 CodeKeeper Advance 自动评审');
    expect(comment).toContain('| **MR** | Add login feature |');
    expect(comment).toContain('| **源分支** | `feature/login` |');
    expect(comment).toContain('| **目标分支** | `main` |');
    expect(comment).toContain('| **作者** | @alice |');
  });

  it('包含总结引用块', () => {
    const comment = formatReviewComment(mockMR, { ...mockResult, findings: [] });
    expect(comment).toContain('### 📋 评审总结');
    expect(comment).toContain('> 发现 2 个问题，建议优先处理 HIGH 级别项。');
  });

  it('无发现项时显示通过提示', () => {
    const comment = formatReviewComment(mockMR, { ...mockResult, findings: [] });
    expect(comment).toContain('✅ 未发现明显问题。');
  });

  it('按 severity 排序并以折叠详情展示发现项', () => {
    const comment = formatReviewComment(mockMR, mockResult);
    expect(comment).toContain('### ⚠️ 发现项（2）');
    expect(comment).toContain('<details open>');
    expect(comment).toContain('#### 🔴 高 · `src/auth.ts:42` · 规则 `AUTH-001`');
    expect(comment).toContain('#### 🟡 低 · `src/utils.ts:7`');
    expect(comment).toContain('**问题描述：**');
    expect(comment).toContain('密码以明文形式传输');
    expect(comment).toContain('**修改建议：**');
    expect(comment).toContain('使用 HTTPS 并对敏感字段加密');
  });

  it('包含生成时间签名', () => {
    const comment = formatReviewComment(mockMR, { ...mockResult, findings: [] });
    expect(comment).toMatch(/\*由 CodeKeeper Advance MR 评审 Agent 生成于 .+\*/);
  });
});
