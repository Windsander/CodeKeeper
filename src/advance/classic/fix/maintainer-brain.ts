import type { ReviewFinding } from '../provider/types.js';
import { LlmClient } from '../../llm/client.js';

/**
 * Maintainer 对单条 finding/discussion 可执行的最终动作
 */
export type MaintainerAction = 'fix' | 'ask' | 'ignore';

/**
 * MaintainerBrain 的决策结果
 */
export interface MaintainerDecision {
  /** 下一步动作 */
  action: MaintainerAction;
  /** 决策理由 */
  reason: string;
  /** 当 action 为 ask 时，要向 Reviewer 提出的问题 */
  question?: string;
  /** 当 action 为 fix 时，可选的修复描述（用于交互式回复场景） */
  fixDescription?: string;
}

export interface MaintainerBrainOptions {
  /** LLM 客户端 */
  llmClient: LlmClient;
  /** 允许自动修复的风险等级列表，未提供则默认全部允许 */
  allowedRiskLevels?: string[];
  /** MR Agent 个性/策略配置（SOUL.md 内容） */
  soulContent?: string;
  /** 项目自动归纳的智库内容（context.md 摘要） */
  projectContext?: string;
}

/**
 * MaintainerBrain
 *
 * Maintainer 的“大脑”：根据文件内容、finding、原始评论或 discussion thread，
 * 由 LLM 自主决定：
 * - 直接修复（fix）
 * - 向 Reviewer 提问澄清（ask）
 * - 忽略本 discussion（ignore）
 */
export class MaintainerBrain {
  private readonly allowedRiskLevels: string[];

  constructor(private readonly options: MaintainerBrainOptions) {
    this.allowedRiskLevels = options.allowedRiskLevels ?? ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  }

  /**
   * 初次看到一条 finding / discussion 时做决策
   */
  async decide(params: {
    finding: ReviewFinding;
    fileContent: string;
    /** 原始评论内容，优先于 finding.message 用于理解 Reviewer 意图 */
    originalComment?: string;
  }): Promise<MaintainerDecision> {
    const { finding, fileContent, originalComment } = params;

    // 风险等级未开启时，不直接修复，而是询问 Reviewer 如何处理
    if (!this.allowedRiskLevels.includes(finding.severity)) {
      return {
        action: 'ask',
        reason: `${finding.severity} 风险等级未开启自动修复`,
        question: `该 finding 的风险等级为 ${finding.severity}，当前未开启自动修复。请 Reviewer 确认是否需要我处理，或指定处理方式。`,
      };
    }

    const prompt = this.buildInitialPrompt(finding, fileContent, originalComment);
    const raw = await this.options.llmClient.complete(prompt, this.systemPrompt());
    return this.parseDecision(raw);
  }

  /**
   * 已经向 Reviewer 提问后，根据 Reviewer 的后续回复决定下一步
   */
  async decideReply(params: {
    filePath: string;
    fileContent: string;
    threadNotes: Array<{ author: string; body: string; createdAt: string }>;
    maintainerName: string;
  }): Promise<MaintainerDecision> {
    const prompt = this.buildReplyPrompt(
      params.filePath,
      params.fileContent,
      params.threadNotes,
      params.maintainerName
    );
    const raw = await this.options.llmClient.complete(prompt, this.systemPrompt());
    return this.parseDecision(raw);
  }

  private systemPrompt(): string {
    const soulSection = this.options.soulContent
      ? `\n\nAgent 个性与策略（SOUL.md）：\n${this.options.soulContent}`
      : '';
    const contextSection = this.options.projectContext
      ? `\n\n项目背景与智库：\n${this.options.projectContext}`
      : '';

    return [
      '你是一名谨慎的代码维护助手（Maintainer Agent）。',
      '你会收到代码文件内容和 Reviewer 在 MR discussion 中提出的意见。',
      `评审规则：根据 Reviewer 意见处理问题并尝试自动修复${soulSection}${contextSection}`,
      '请根据你对问题的理解，自主决定下一步动作：',
      '- "fix"：你确信可以根据 Reviewer 的意见做出最小且正确的代码修改。请同时给出简要修复描述。',
      '- "ask"：评论含糊、缺少上下文、或你不确定如何安全修改。请直接向 Reviewer 提出一个简洁、有针对性的澄清问题。',
      '- "ignore"：评论明显不需要代码改动（例如只是赞美、已过期、或不相关）。请说明原因。',
      '只能输出 JSON，不要输出任何解释文字。',
    ].join('\n');
  }

  private buildInitialPrompt(
    finding: ReviewFinding,
    fileContent: string,
    originalComment?: string
  ): string {
    return [
      '## 文件路径',
      finding.file,
      '',
      '## 文件内容（节选）',
      '```',
      this.truncate(fileContent),
      '```',
      '',
      '## Reviewer 评论',
      originalComment ?? '',
      '',
      '## 解析出的 finding',
      `- 严重程度：${finding.severity}`,
      finding.ruleId ? `- 规则：${finding.ruleId}` : '',
      `- 行号：${finding.line}`,
      `- 问题描述：${finding.message}`,
      `- 修改建议：${finding.suggestion}`,
      '',
      '请输出 JSON：',
      '{',
      '  "action": "fix" | "ask" | "ignore",',
      '  "reason": "简要说明理由",',
      '  "question": "如果 action=ask，填写向 Reviewer 提出的澄清问题",',
      '  "fixDescription": "如果 action=fix，可选的修复描述"',
      '}',
    ].join('\n');
  }

  private buildReplyPrompt(
    filePath: string,
    fileContent: string,
    threadNotes: Array<{ author: string; body: string; createdAt: string }>,
    maintainerName: string
  ): string {
    const threadText = threadNotes
      .map((note) => `[${note.author}]\n${note.body}`)
      .join('\n\n---\n\n');

    return [
      '## 文件路径',
      filePath,
      '',
      '## 文件内容（节选）',
      '```',
      this.truncate(fileContent),
      '```',
      '',
      '## 本 discussion 的完整对话',
      '以下包含 Reviewer 和 Maintainer 的所有评论。',
      '',
      threadText,
      '',
      `## 你的身份\n你是 ${maintainerName}。`,
      '',
      '请根据 Reviewer 的最新回复，判断下一步动作，并输出 JSON：',
      '{',
      '  "action": "fix" | "ask" | "ignore",',
      '  "reason": "简要说明理由",',
      '  "question": "如果 action=ask，填写向 Reviewer 提出的澄清问题",',
      '  "fixDescription": "如果 action=fix，可选的修复描述"',
      '}',
    ].join('\n');
  }

  private truncate(content: string, maxLines = 80): string {
    const lines = content.split('\n');
    if (lines.length <= maxLines) return content;
    return lines.slice(0, maxLines).join('\n') + '\n...（内容已截断）';
  }

  private parseDecision(raw: string): MaintainerDecision {
    const text = raw.trim();
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonText = jsonMatch ? jsonMatch[1].trim() : text;

    try {
      const parsed = JSON.parse(jsonText) as {
        action: string;
        reason?: string;
        question?: string;
        fixDescription?: string;
      };

      switch (parsed.action) {
        case 'fix':
          return {
            action: 'fix',
            reason: parsed.reason ?? '可以安全修复',
            fixDescription: parsed.fixDescription,
          };
        case 'ask':
          return {
            action: 'ask',
            reason: parsed.reason ?? '需要澄清',
            question: parsed.question ?? '能否补充一下期望的修改方式或范围？',
          };
        case 'ignore':
          return {
            action: 'ignore',
            reason: parsed.reason ?? '无需处理',
          };
        default:
          throw new Error(`未知的 action: ${parsed.action}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[MaintainerBrain] 解析 LLM 决策失败:', message, '原始响应:', raw);
      // 解析失败时保守地选择继续询问
      return {
        action: 'ask',
        reason: '无法解析 LLM 决策，需要 Reviewer 进一步说明',
        question: '我没有完全理解你的意思，能否再说得具体一些？',
      };
    }
  }
}
