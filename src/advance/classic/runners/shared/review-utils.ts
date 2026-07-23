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
 * 角色签名中的角色标签
 */
export const REVIEWER_ROLE_LABEL = 'MR 评审 Agent';
export const MAINTAINER_ROLE_LABEL = 'MR 维护 Agent';

/**
 * 判断一条 note body 是否由 CodeKeeper Agent 发出
 */
export function isAgentAuthoredNote(body: string): boolean {
  return body.includes('CodeKeeper Advance');
}

/**
 * 判断一条 note body 是否由 Maintainer Agent 发出
 */
export function isMaintainerAuthoredNote(body: string): boolean {
  return body.includes(`CodeKeeper Advance ${MAINTAINER_ROLE_LABEL}`);
}

/** 判断 Maintainer note 是否已经给出“无需修复/已经修复”的最终说明。 */
export function isMaintainerNoFixExplanationNote(body: string): boolean {
  if (!isMaintainerAuthoredNote(body)) return false;
  return (
    /✅[\s\S]{0,120}(?:已修复|已经修复|已处理|无需修复|无需修改)/.test(body) ||
    /📝[\s\S]{0,120}(?:已忽略|决定忽略)/.test(body)
  );
}

/**
 * 自动化 bot 作者的命名模式。
 *
 * 覆盖：
 * - GitLab project/group access token bot：`project_123_bot_<hex>`、`group_456_bot_<hex>`
 * - 常见 CI/自动化 bot 命名：`ci-bot`、`review-bot`、`dependabot[bot]` 等
 *
 * 只用于把「明确的自动化账号」排除在「人工回复」之外；
 * 拿不准的一律视为人工，避免漏掉真实用户的新信息。
 */
const BOT_AUTHOR_PATTERN =
  /(?:^|[_\-[\]])(?:bot|ci|codekeeper|gitlab|jenkins|github|renovate|dependabot)(?:[_\-[\]]|$)|_bot_[a-f0-9]{8,}$/i;

/**
 * 判断 note 作者是否为自动化 bot。
 *
 * bot 的自动重扫/补发不带新信息，不应触发重评估；
 * 也不应成为 Maintainer 提问/轻松回复的对象（发了也无人回应）。
 */
export function isBotAuthor(author: string | undefined): boolean {
  if (!author) return false;
  return BOT_AUTHOR_PATTERN.test(author);
}

/**
 * 生成 Agent 身份签名 footer
 *
 * 统一格式：
 *   ---
 *   *生成于 YYYY/MM/DD HH:mm:ss · CodeKeeper Advance <角色标签> · <名称>*
 */
export function formatAgentFooter(roleLabel: string, agentName?: string): string {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const identity = agentName
    ? `CodeKeeper Advance ${roleLabel} · ${agentName}`
    : `CodeKeeper Advance ${roleLabel}`;
  return `---\n*生成于 ${now} · ${identity}*`;
}

/**
 * 生成单条 finding 的 discussion body
 */
export function formatFindingDiscussionBody(finding: ReviewFinding, agentName?: string): string {
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
    formatAgentFooter(REVIEWER_ROLE_LABEL, agentName),
  ].join('\n');
}

/**
 * 为指定 MR 生成 summary 评论正文
 *
 * 仅用于 reviewer 角色，汇总所有 findings。
 */
export function formatReviewComment(mr: MergeRequest, result: ReviewResult, agentName?: string): string {
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

  lines.push(formatAgentFooter(REVIEWER_ROLE_LABEL, agentName));

  return lines.join('\n');
}

/**
 * 生成追加评审评论正文
 *
 * 当 MR 有新 commit 或发现新问题时，在原 summary 下追加一条补充说明。
 */
export function formatSupplementaryReviewComment(mr: MergeRequest, newFindings: ReviewFinding[], agentName?: string): string {
  const severityOrder: ReviewFinding['severity'][] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  const groups = groupFindingsBySeverity(newFindings);
  const total = newFindings.length;

  const lines: string[] = [
    `### 📝 补充评审（MR 有更新）`,
    ``,
    `**MR**: ${mr.title}<br>`,
    `**新增发现项**: ${total} 个`,
    ``,
  ];

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

  lines.push(formatAgentFooter(REVIEWER_ROLE_LABEL, agentName));

  return lines.join('\n');
}
export function formatFindingThreadComment(finding: ReviewFinding, agentName?: string): string {
  const severityEmoji: Record<ReviewFinding['severity'], string> = {
    CRITICAL: '🚨',
    HIGH: '🔴',
    MEDIUM: '🟠',
    LOW: '🟡',
  };
  const parts = [
    `${severityEmoji[finding.severity]} **${finding.severity}**${finding.ruleId ? ` · 规则 \`${finding.ruleId}\`` : ''}`,
    '',
    `**问题描述**：${finding.message}`,
    '',
    `**修改建议**：${finding.suggestion}`,
    '',
    formatAgentFooter(REVIEWER_ROLE_LABEL, agentName),
  ];
  return parts.join('\n');
}
