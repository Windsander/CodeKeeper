import type { AstGrepFinding, DiffChunk } from '../types.js';

const REVIEW_SYSTEM_PROMPT = `You are a strict and thorough code reviewer. Your task is to review code changes and identify issues based on the project's rules.

## Review Principles
1. Be precise — cite file paths and line numbers
2. Be actionable — provide specific fix suggestions with code snippets
3. Prioritize — focus on correctness, security, and maintainability over style nits
4. Be concise — avoid verbose explanations

## Severity Levels
- CRITICAL: Security vulnerability, data loss, or crash risk
- HIGH: Bug, incorrect behavior, or significant maintainability issue
- MEDIUM: Code smell, missing edge case handling, or minor type safety issue
- LOW: Style inconsistency, missing documentation, or minor optimization opportunity

## Output Format
Respond with a JSON object in this exact format:
{
  "findings": [
    {
      "severity": "HIGH",
      "file": "src/main/ipc/account.ts",
      "line": 78,
      "ruleId": "security/env-check",
      "message": "Environment variable APP_USER_DATA_OVERRIDE is used without isPackaged guard",
      "suggestion": "Add guard: if (overridePath && !app.isPackaged) { app.setPath('userData', overridePath); }"
    }
  ],
  "summary": "Found 1 HIGH severity issue related to unguarded environment variable usage",
  "autoFixable": [0]
}

The "autoFixable" array contains indices of findings that can be automatically fixed (clear, localized changes).`;

/**
 * Build review prompt from rules + diff + ast-grep findings
 */
export function buildReviewPrompt(
  claudeMdRules: string,
  diffChunk: DiffChunk,
  astGrepFindings: AstGrepFinding[],
  mrTitle: string,
  mrDescription: string
): string {
  const parts: string[] = [];

  // System prompt
  parts.push(REVIEW_SYSTEM_PROMPT);

  // Chunk context
  if (diffChunk.total > 1) {
    parts.push(`\n---\n## Review Context\nThis is chunk ${diffChunk.index + 1} of ${diffChunk.total}. Focus only on the files in this chunk.\n`);
  }

  // MR context
  parts.push(`\n---\n## Merge Request\n**Title:** ${mrTitle}\n**Description:** ${mrDescription || '(no description)'}\n`);

  // Project rules
  parts.push(`\n---\n## Project Rules (from CLAUDE.md)\n${truncateRules(claudeMdRules, 8000)}\n`);

  // ast-grep pre-check results
  if (astGrepFindings.length > 0) {
    parts.push(`\n---\n## ast-grep Pre-check Results\nThe following issues were detected by static analysis:\n`);
    for (const finding of astGrepFindings.slice(0, 20)) {
      parts.push(`- [${finding.severity}] ${finding.ruleId}: ${finding.message} (${finding.file}:${finding.line})`);
    }
    parts.push('\n');
  }

  // Diff content
  parts.push(`\n---\n## Code Changes\n\`\`\`diff\n`);
  for (const file of diffChunk.files) {
    parts.push(file.diff);
  }
  parts.push('\n```\n');

  // Reminder
  parts.push(`\n---\n## Instructions\n1. Review the code changes against the project rules above\n2. Identify any issues, bugs, or improvements\n3. Respond ONLY with the JSON format specified above\n4. Ensure all file paths and line numbers are accurate\n`);

  return parts.join('');
}

/**
 * Build fix prompt for a single finding
 */
export function buildFixPrompt(
  filePath: string,
  fileContent: string,
  finding: {
    line: number;
    message: string;
    suggestion: string;
  }
): string {
  return `You are a code fixer. Apply the following fix to the file.

## File: ${filePath}

## Issue
${finding.message}

## Suggestion
${finding.suggestion}

## Current File Content
\`\`\`${filePath.split('.').pop() || 'ts'}
${fileContent}
\`\`\`

## Instructions
1. Apply the fix to the file content above
2. Return the COMPLETE updated file content (not just the changed part)
3. Do not add any explanations, markdown formatting, or JSON
4. Output only the raw file content
5. Preserve all existing code that doesn't need to change`;
}

/**
 * Truncate CLAUDE.md rules to fit within token budget
 */
function truncateRules(rules: string, maxChars: number): string {
  if (rules.length <= maxChars) {
    return rules;
  }

  // Try to truncate at section boundary
  const sections = rules.split(/\n##\s+/);
  let result = sections[0];

  for (let i = 1; i < sections.length; i++) {
    const next = result + '\n## ' + sections[i];
    if (next.length > maxChars) {
      result += '\n\n... (truncated for length)';
      break;
    }
    result = next;
  }

  return result;
}

/**
 * Format review findings into a GitLab MR comment
 */
export function formatReviewComment(result: {
  findings: Array<{
    severity: string;
    file: string;
    line: number;
    message: string;
    suggestion: string;
  }>;
  summary: string;
  chunkInfo?: { index: number; total: number };
}): string {
  const lines: string[] = [];

  lines.push('## 🤖 CodeKeeper Code Review');

  if (result.chunkInfo && result.chunkInfo.total > 1) {
    lines.push(`\n> Part ${result.chunkInfo.index + 1} of ${result.chunkInfo.total}`);
  }

  lines.push('');

  if (result.findings.length === 0) {
    lines.push('✅ No issues found. Great job!');
    return lines.join('\n');
  }

  // Severity summary
  const bySeverity: Record<string, number> = {};
  for (const f of result.findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  }

  lines.push('### Summary');
  lines.push(`| Severity | Count |`);
  lines.push(`|----------|-------|`);
  for (const [sev, count] of Object.entries(bySeverity).sort(
    ([a], [b]) => severityOrder(b) - severityOrder(a)
  )) {
    lines.push(`| ${severityEmoji(sev)} ${sev} | ${count} |`);
  }
  lines.push('');

  // Findings details
  lines.push('### Findings');
  lines.push('');

  for (let i = 0; i < result.findings.length; i++) {
    const f = result.findings[i];
    lines.push(`#### ${i + 1}. ${severityEmoji(f.severity)} [${f.severity}] ${f.message}`);
    lines.push(`- **File:** \`${f.file}\` (line ${f.line})`);
    if (f.suggestion) {
      lines.push(`- **Suggestion:**`);
      lines.push('```');
      lines.push(f.suggestion);
      lines.push('```');
    }
    lines.push('');
  }

  return lines.join('\n');
}

function severityOrder(sev: string): number {
  const order: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  return order[sev] || 0;
}

function severityEmoji(sev: string): string {
  const emojis: Record<string, string> = {
    CRITICAL: '🚨',
    HIGH: '⚠️',
    MEDIUM: '💡',
    LOW: 'ℹ️',
  };
  return emojis[sev] || '•';
}
