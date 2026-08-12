/**
 * 提交管道：框架侧的确定性兜底
 *
 * 目标（见 docs/goals/maintainer-llm-centric-goal.md 子目标 B）：
 * - F2：commit message 三级兜底（EverOS 记忆 → 仓库静态探测 → 合规通用默认），
 *   LLM 只需提供"改了什么"，格式拼装是框架的事；
 * - F3：任何 commit/push 失败先由框架机械预处理（去 ANSI、截尾、归类、蒸馏），
 *   可模板化修复的直接重试，不能的蒸馏成 ≤10 行诊断再交给上层；
 * - L3：lint/test 类 hook 失败的蒸馏结果可回流修复循环，而非直接判死。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripTerminalControlCodes } from '../runners/shared/reply-safety.js';

/** commit/push 失败的机械归类 */
export type CommitFailureKind =
  | 'commit-message'
  | 'lint'
  | 'test'
  | 'typecheck'
  | 'permission'
  | 'push'
  | 'unknown';

/** 去除 ANSI 转义码，避免 hook 输出中的颜色控制字符干扰规范提取 */
export function stripAnsiCodes(text: string): string {
  return stripTerminalControlCodes(text);
}

/** 保留 hook 输出尾部诊断，避免前置 lint/test 日志淹没最终拒绝原因 */
export function extractCommitRejectionSection(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').trimEnd();
  const tailLines = normalized.split('\n').slice(-120).join('\n');
  return tailLines.slice(-8000);
}

const COMMIT_MESSAGE_PATTERN =
  /commit\s?message|提交信息|提交标题|conventional\s?commits|commitlint|header|subject|首行|格式.*不合规|不符合.*(?:规范|模板|约束|规则)/i;
const TEST_PATTERN = /\bFAIL\b|✗|✘|failed\s+tests?|Tests\s+\d+\s+failed|测试失败/i;
const LINT_PATTERN = /eslint|lint\s*错误|✖\s+\d+\s+problem|\d+\s+errors?/i;
const TYPECHECK_PATTERN = /tsc|TS\d{4}|type ?check|类型检查/i;
const PERMISSION_PATTERN = /permission\s+denied|403|401|unauthorized|forbidden|没有权限|权限不足/i;
const PUSH_PATTERN = /non-fast-forward|rejected|failed to push|推送被拒|冲突/i;

/**
 * 对 commit/push 失败输出做机械归类。
 *
 * 只看蒸馏后的尾部诊断（最终拒绝原因通常在末尾），优先级：
 * commit-message > test > typecheck > lint > permission > push > unknown。
 * commit-message 最优先：pre-commit hook 往往先跑 lint/test（产生大量噪音），
 * 最后才以提交信息规范为由拒绝，尾部模式才是真实死因。
 */
export function classifyCommitFailure(diagnostic: string): CommitFailureKind {
  const tail = extractCommitRejectionSection(stripAnsiCodes(diagnostic));
  const tailLines = tail.split('\n').slice(-30).join('\n');
  if (COMMIT_MESSAGE_PATTERN.test(tailLines)) return 'commit-message';
  if (TEST_PATTERN.test(tailLines)) return 'test';
  if (TYPECHECK_PATTERN.test(tailLines)) return 'typecheck';
  if (LINT_PATTERN.test(tailLines)) return 'lint';
  if (PERMISSION_PATTERN.test(tailLines)) return 'permission';
  if (PUSH_PATTERN.test(tailLines)) return 'push';
  return 'unknown';
}

/** 各归类的一句话处置建议，供蒸馏诊断与上层决策使用 */
const KIND_GUIDANCE: Record<CommitFailureKind, string> = {
  'commit-message': '提交信息不符合项目规范，应理解规则后重写 message 重试',
  lint: 'pre-commit hook 的 lint 检查未通过，应回流修复循环消除新增 error 后重试',
  test: 'pre-commit hook 的测试未通过，应回流修复循环修复失败用例后重试',
  typecheck: 'pre-commit hook 的类型检查未通过，应回流修复循环消除类型错误后重试',
  permission: 'git 权限不足，属于环境/凭据问题，不应重试，需人工介入',
  push: 'push 被拒绝（多为分支冲突/非快进），应先同步远端再试，必要时人工介入',
  unknown: '无法机械归类，需 LLM 阅读蒸馏诊断后判断',
};

/**
 * 把任意 commit/push 失败输出蒸馏为 ≤ maxLines 行的诊断。
 * 第一行为归类与建议，其后为尾部关键证据——发布到 MR 的只能是这个，
 * 而不是几千行的 hook 原文。
 */
export function distillCommitFailure(rawError: string, maxLines = 10): string {
  const kind = classifyCommitFailure(rawError);
  const tail = extractCommitRejectionSection(stripAnsiCodes(rawError))
    .split('\n')
    .filter(line => line.trim().length > 0);
  const evidenceBudget = Math.max(1, maxLines - 1);
  const evidence = tail
    .slice(-evidenceBudget)
    .map(line => (line.length > 800 ? `${line.slice(0, 799)}…` : line));
  const distilled = [`【提交失败分类: ${kind}】${KIND_GUIDANCE[kind]}`, ...evidence].join('\n');
  return distilled.length > 6_000 ? `${distilled.slice(0, 5_999)}…` : distilled;
}

/** commitlint/husky 等静态配置探测结果 */
const CONVENTIONAL_COMMITS_HINT =
  'Conventional Commits：格式 <type>(<scope>): <description>，' +
  'type 通常为 feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert';

/**
 * 静态探测仓库的提交信息规范（第二级兜底）。
 *
 * 依次检查 commitlint 配置文件、package.json 的 commitlint 键、husky commit-msg 钩子；
 * 命中即返回 Conventional Commits 提示。探测不到返回 undefined，
 * 由调用方回退到合规通用默认 message。
 */
export function detectCommitConvention(repoRoot: string): string | undefined {
  try {
    const commitlintFiles = [
      'commitlint.config.js',
      'commitlint.config.ts',
      'commitlint.config.mjs',
      'commitlint.config.cjs',
      '.commitlintrc',
      '.commitlintrc.json',
      '.commitlintrc.js',
      '.commitlintrc.yml',
      '.commitlintrc.yaml',
    ];
    if (commitlintFiles.some(file => existsSync(join(repoRoot, file)))) {
      return CONVENTIONAL_COMMITS_HINT;
    }
    const pkgPath = join(repoRoot, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      if (pkg.commitlint || pkg['commitlint-config']) {
        return CONVENTIONAL_COMMITS_HINT;
      }
    }
    if (existsSync(join(repoRoot, '.husky', 'commit-msg'))) {
      return CONVENTIONAL_COMMITS_HINT;
    }
  } catch {
    // 探测失败不阻断提交，回退默认
  }
  return undefined;
}

const CONVENTIONAL_SUBJECT = /^[a-z]+(?:\([^)]*\))?:\s/i;

/** 为朴素主题行补一个 Conventional Commits 前缀（若尚未具备） */
export function ensureConventionalSubject(subject: string, type: string, scope: string): string {
  const trimmed = subject.trim();
  if (CONVENTIONAL_SUBJECT.test(trimmed)) return trimmed;
  return `${type}(${scope}): ${trimmed}`;
}

/** 合规的单 finding 默认提交信息 */
export function buildDefaultFixMessage(finding: {
  message: string;
  ruleId?: string;
  file: string;
  line: number;
}): string {
  const subject = ensureConventionalSubject(finding.message, 'fix', 'review');
  return [
    subject,
    '',
    `规则: ${finding.ruleId ?? 'N/A'}`,
    `文件: ${finding.file}:${finding.line}`,
  ].join('\n');
}

/** 合规的批量修复默认提交信息 */
export function buildDefaultBatchMessage(appliedFiles: string[], deletedFiles: string[]): string {
  const total = appliedFiles.length + deletedFiles.length;
  const lines = [`fix(review): 批量修复 ${total} 个 Reviewer 问题`, ''];
  if (appliedFiles.length > 0) {
    lines.push('修改文件：', ...appliedFiles.map(f => `- ${f}`), '');
  }
  if (deletedFiles.length > 0) {
    lines.push('删除文件：', ...deletedFiles.map(f => `- ${f}`), '');
  }
  return lines.join('\n');
}

/** 合规的删除文件默认提交信息 */
export function buildDefaultDeleteMessage(fileName: string): string {
  return `chore(review): 移除不应上传的文件 ${fileName}`;
}
