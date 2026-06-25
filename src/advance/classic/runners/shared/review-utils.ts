/**
 * 评审相关工具函数
 *
 * 供 ReviewerRunner 和 MaintainerRunner 共享使用。
 */

import type { ReviewFinding, MergeRequest, ReviewResult } from '../../provider/types.js';

/**
 * Severity 到图标和颜色标签的映射
 */
export const SEVERITY_META: Record<
  ReviewFinding['severity'],
  { icon: string; label: string; color: string }
> = {
  CRITICAL: { icon: '🚨', label: '严重', color: '#dc2626' },
  HIGH: { icon: '🔴', label: '高', color: '#ea580c' },
  MEDIUM: { icon: '🟠', label: '中', color: '#d97706' },
  LOW: { icon: '🟡', label: '低', color: '#ca8a04' },
};

/**
 * 按 severity 对 findings 分组
 */
export function groupFindingsBySeverity(
  findings: ReviewFinding[]
): Record<ReviewFinding['severity'], ReviewFinding[]> {
  const groups: Record<ReviewFinding['severity'], ReviewFinding[]> = {
    CRITICAL: [],
    HIGH: [],
    MEDIUM: [],
    LOW: [],
  };
  for (const f of findings) {
    groups[f.severity].push(f);
  }
  return groups;
}

/**
 * 把 LLM 生成的总结文本格式化为 Markdown 引用块行
 *
 * 例如将 "存在两处改进点：1) ... 2) ..." 转换为真正的列表，增强可读性。
 */
export function formatSummary(summary: string): string[] {
  let formatted = summary.replace(/(\d+)\)\s*/g, '$1. ');
  formatted = formatted.replace(/([^\n])(\d+\.\s)/g, '$1\n$2');
  return formatted.split('\n').map((line) => `> ${line}`);
}

/**
 * 生成单条 finding 的 discussion body
 */
export function formatFindingDiscussionBody(finding: ReviewFinding): string {
  const meta = SEVERITY_META[finding.severity];
  const ruleTag = finding.ruleId ? ` · 规则 \`${finding.ruleId}\`` : '';
  return [
    `## ${meta.icon} ${meta.label}${ruleTag}`,
    ``,
    `**问题描述：**`,
    finding.message,
    ``,
    `**修改建议：**`,
    finding.suggestion,
    ``,
    `*CodeKeeper Advance MR 评审 Agent*`,
  ].join('\n');
}

/**
 * 为指定 MR 生成 summary 评论正文
 *
 * 仅用于 reviewer 角色，汇总所有 findings。
 */
export function formatReviewComment(mr: MergeRequest, result: ReviewResult): string {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const severityOrder: ReviewFinding['severity'][] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  const groups = groupFindingsBySeverity(result.findings);
  const total = result.findings.length;

  const lines: string[] = [
    `## 🤖 CodeKeeper 自动评审`,
    ``,
    `**MR**: ${mr.title}<br>`,
    `**分支**: \`${mr.sourceBranch}\` → \`${mr.targetBranch}\`<br>`,
    `**发现项**: ${total > 0 ? `${total} 个` : '✅ 无'}`,
    ``,
    ...formatSummary(result.summary),
    ``,
  ];

  if (total > 0) {
    lines.push(`### ⚠️ 发现项`, ``);
    for (const severity of severityOrder) {
      const items = groups[severity];
      if (items.length === 0) continue;
      const meta = SEVERITY_META[severity];
      lines.push(`- ${meta.icon} **${meta.label}** (${items.length})`);
      for (const finding of items) {
        const ruleTag = finding.ruleId ? ` · 规则 \`${finding.ruleId}\`` : '';
        lines.push(
          `  - \`${finding.file}:${finding.line}\`${ruleTag} ${finding.message}<br>**建议**：${finding.suggestion}`
        );
      }
      lines.push(``);
    }
  }

  lines.push(`---`, ``, `*生成于 ${now} · CodeKeeper Advance MR 评审 Agent*`);

  return lines.join('\n');
}
