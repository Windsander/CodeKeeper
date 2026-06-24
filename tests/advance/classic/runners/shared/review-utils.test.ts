/**
 * review-utils 单元测试
 *
 * 验证评审格式化工具函数的正确性。
 */

import { describe, it, expect } from 'vitest';
import {
  formatReviewComment,
  formatFindingDiscussionBody,
  groupFindingsBySeverity,
  formatSummary,
  SEVERITY_META,
} from '../../../../../src/advance/classic/runners/shared/review-utils.js';
import type { MergeRequest, ReviewResult, ReviewFinding } from '../../../../../src/advance/classic/provider/types.js';

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
  it('包含精简的 MR 元信息', () => {
    const comment = formatReviewComment(mockMR, { ...mockResult, findings: [] });
    expect(comment).toContain('## 🤖 CodeKeeper 自动评审');
    expect(comment).toContain('**MR**: Add login feature<br>');
    expect(comment).toContain('**分支**: `feature/login` → `main`<br>');
    expect(comment).toContain('**发现项**: ✅ 无');
  });

  it('包含总结引用块', () => {
    const comment = formatReviewComment(mockMR, { ...mockResult, findings: [] });
    expect(comment).toContain('> 发现 2 个问题，建议优先处理 HIGH 级别项。');
  });

  it('把总结中的数字列表转换为 Markdown 列表', () => {
    const result: ReviewResult = {
      findings: [],
      summary: '存在两处改进点：1) 第一点 2) 第二点',
      autoFixable: [],
    };
    const comment = formatReviewComment(mockMR, result);
    expect(comment).toContain('> 存在两处改进点：');
    expect(comment).toContain('> 1. 第一点');
    expect(comment).toContain('> 2. 第二点');
  });

  it('按 severity 分组并以紧凑列表展示发现项', () => {
    const comment = formatReviewComment(mockMR, mockResult);
    expect(comment).toContain('**发现项**: 2 个');
    expect(comment).toContain('### ⚠️ 发现项');
    expect(comment).toContain('- 🔴 **高** (1)');
    expect(comment).toContain('- 🟡 **低** (1)');
    expect(comment).toContain(
      '  - `src/auth.ts:42` · 规则 `AUTH-001` 密码以明文形式传输<br>**建议**：使用 HTTPS 并对敏感字段加密'
    );
    expect(comment).toContain(
      '  - `src/utils.ts:7` 缺少空值检查<br>**建议**：添加可选链或默认值'
    );
  });

  it('包含生成时间签名', () => {
    const comment = formatReviewComment(mockMR, { ...mockResult, findings: [] });
    expect(comment).toMatch(/\*生成于 .+ · CodeKeeper Advance MR 评审 Agent\*/);
  });
});

describe('formatFindingDiscussionBody', () => {
  it('生成包含 severity 图标和规则 ID 的 discussion body', () => {
    const finding: ReviewFinding = {
      severity: 'CRITICAL',
      file: 'src/auth.ts',
      line: 42,
      ruleId: 'AUTH-001',
      message: '密码以明文形式传输',
      suggestion: '使用 HTTPS 并对敏感字段加密',
    };
    const body = formatFindingDiscussionBody(finding);
    expect(body).toContain('## 🚨 严重 · 规则 `AUTH-001`');
    expect(body).toContain('密码以明文形式传输');
    expect(body).toContain('使用 HTTPS 并对敏感字段加密');
  });

  it('无规则 ID 时不显示规则标签', () => {
    const finding: ReviewFinding = {
      severity: 'HIGH',
      file: 'src/utils.ts',
      line: 7,
      message: '缺少空值检查',
      suggestion: '添加可选链或默认值',
    };
    const body = formatFindingDiscussionBody(finding);
    expect(body).toContain('## 🔴 高');
    expect(body).not.toContain('规则');
  });
});

describe('groupFindingsBySeverity', () => {
  it('按 severity 正确分组', () => {
    const findings: ReviewFinding[] = [
      { severity: 'HIGH', file: 'a.ts', line: 1, message: 'm1', suggestion: 's1' },
      { severity: 'LOW', file: 'b.ts', line: 2, message: 'm2', suggestion: 's2' },
      { severity: 'HIGH', file: 'c.ts', line: 3, message: 'm3', suggestion: 's3' },
    ];
    const groups = groupFindingsBySeverity(findings);
    expect(groups.HIGH).toHaveLength(2);
    expect(groups.LOW).toHaveLength(1);
    expect(groups.CRITICAL).toHaveLength(0);
    expect(groups.MEDIUM).toHaveLength(0);
  });
});

describe('formatSummary', () => {
  it('将数字列表转换为 Markdown 格式', () => {
    const lines = formatSummary('1) 第一项 2) 第二项');
    expect(lines).toContain('> 1. 第一项 ');
    expect(lines).toContain('> 2. 第二项');
  });

  it('普通文本也包装为引用块', () => {
    const lines = formatSummary('这是一个普通总结');
    expect(lines).toEqual(['> 这是一个普通总结']);
  });
});

describe('SEVERITY_META', () => {
  it('包含所有 severity 级别的元数据', () => {
    expect(SEVERITY_META.CRITICAL).toEqual({ icon: '🚨', label: '严重', color: '#dc2626' });
    expect(SEVERITY_META.HIGH).toEqual({ icon: '🔴', label: '高', color: '#ea580c' });
    expect(SEVERITY_META.MEDIUM).toEqual({ icon: '🟠', label: '中', color: '#d97706' });
    expect(SEVERITY_META.LOW).toEqual({ icon: '🟡', label: '低', color: '#ca8a04' });
  });
});
