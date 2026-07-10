/**
 * 问题范围分类器
 *
 * 把 Reviewer finding 快速分为 trivial / local / cross-file / needs-clarification，
 * 决定后续修复策略。先走启发式规则，未命中时可再用轻量 LLM 确认。
 */

import type { LlmClient } from '../../llm/client.js';
import type { ReviewFinding } from '../provider/types.js';
import type { FocusedContext } from './focused-context-builder.js';
import { extractJsonText } from '../utils/json-extraction.js';

export type IssueScope = 'trivial' | 'local' | 'cross-file' | 'needs-clarification';

export interface ScopeClassification {
  scope: IssueScope;
  reason: string;
}

export interface ScopeClassifierOptions {
  /** 可选的 LLM 客户端，用于规则未命中时二次确认 */
  llmClient?: LlmClient;
  /** 是否启用 LLM 二次确认；默认 false，避免每个 finding 都调用 LLM */
  enableLlmConfirm?: boolean;
}

const CONTROL_FLOW_KEYWORDS = /\b(if|else|for|while|switch|case|try|catch|finally|return|throw|async|await|function|class|interface|type)\b/;

export class IssueScopeClassifier {
  constructor(private readonly options: ScopeClassifierOptions = {}) {}

  async classify(finding: ReviewFinding, context: FocusedContext): Promise<ScopeClassification> {
    const heuristic = this.classifyByRules(finding);
    if (heuristic.scope !== 'local') {
      return heuristic;
    }

    if (this.options.enableLlmConfirm && this.options.llmClient) {
      return await this.confirmWithLlm(finding, context);
    }

    return heuristic;
  }

  private classifyByRules(finding: ReviewFinding): ScopeClassification {
    if (!finding.file || finding.line <= 0) {
      return {
        scope: 'needs-clarification',
        reason: '缺少文件路径或行号',
      };
    }

    const text = `${finding.message} ${finding.suggestion} ${finding.ruleId ?? ''}`.toLowerCase();

    if (text.length < 10 || finding.message.trim().length < 3) {
      return {
        scope: 'needs-clarification',
        reason: '问题描述过短，无法判断改动范围',
      };
    }

    if (this.isTrivial(text, finding)) {
      return {
        scope: 'trivial',
        reason: '命中轻量规则：单行/字段/注释类修改',
      };
    }

    if (this.isCrossFile(text, finding)) {
      return {
        scope: 'cross-file',
        reason: '命中跨文件规则：类型/接口/签名变更或影响调用点',
      };
    }

    return {
      scope: 'local',
      reason: '未命中特殊规则，按局部修改处理',
    };
  }

  private isTrivial(text: string, finding: ReviewFinding): boolean {
    // 注释 / TODO
    if (/添加\s*todo|todo\s*注释|缺少\s*注释|加注释/.test(text)) return true;
    // 缓存环境变量或常量
    if (/缓存\s*(环境变量|常量|变量值)|const\s+\w+\s*=\s*!!?process\.env/.test(text)) return true;
    if (text.includes('缓存') && (text.includes('环境变量') || text.includes('process.env'))) return true;
    // 添加可选字段 / 单个字段补全
    if (/添加\s*(可选的?)?\s*字段|加\s*(可选的?)?\s*字段|\?\s*:/.test(text)) return true;
    // 拼写 / 命名
    if (/拼写|typo|重命名|改名/.test(text)) return true;
    // 缺少 import / 类型导入
    if (/缺少\s*import|缺少\s*类型|引入\s*类型/.test(text)) return true;

    // 单行补全：建议里提到“添加”某个具体字段/值，且不涉及控制流
    if (
      /添加\s*["'`]?[\w$]+["'`]?\s*(字段|属性|值|参数)?/.test(text) &&
      !CONTROL_FLOW_KEYWORDS.test(text)
    ) {
      return true;
    }

    // 规则 ID 直接提示是文档/注释类
    const ruleId = (finding.ruleId ?? '').toUpperCase();
    if (['TODO', 'DOCUMENTATION', 'COMMENT', 'CHANGE-MANAGEMENT', 'PERFORMANCE'].some((r) => ruleId.includes(r))) {
      return true;
    }

    return false;
  }

  private isCrossFile(text: string, finding: ReviewFinding): boolean {
    if (/接口定义|类型定义|interface|类型\s*变更|函数签名|签名变更/.test(text)) return true;
    if (/调用点|调用方|所有.*调用|影响.*调用|多处.*调用/.test(text)) return true;
    if (/导出.*改名|导出.*重命名|public\s+api.*变更/.test(text)) return true;
    if (/多个文件|跨文件|cross.file/.test(text)) return true;

    const ruleId = (finding.ruleId ?? '').toUpperCase();
    if (['TYPE-SAFETY', 'API-COMPATIBILITY', 'BREAKING-CHANGE'].some((r) => ruleId.includes(r))) {
      return true;
    }

    return false;
  }

  private async confirmWithLlm(
    finding: ReviewFinding,
    context: FocusedContext
  ): Promise<ScopeClassification> {
    const llmClient = this.options.llmClient;
    if (!llmClient) {
      return { scope: 'local', reason: 'LLM 客户端未配置，按局部修改处理' };
    }

    const prompt = `请判断以下代码评审问题的修改范围，只输出 JSON。

文件：${finding.file}
行号：${finding.line}
问题描述：${finding.message}
修改建议：${finding.suggestion}
相关代码片段（行 ${context.snippetStartLine}-${context.snippetEndLine}）：
${context.snippet}

请从以下范围中选一个，并给出理由：
- trivial：只需改一行/一个字段/一条注释，无风险。
- local：需要在一个函数或文件内做局部重构，但不出当前文件。
- cross-file：涉及类型定义、接口变更、函数签名变化，需要同时修改多个文件或调用点。
- needs-clarification：描述不清或需要 Reviewer 确认设计方向。

输出格式：
{
  "scope": "trivial|local|cross-file|needs-clarification",
  "reason": "一句话说明"
}`;

    const raw = await llmClient.completeJson(
      prompt,
      '你是代码修改范围判断助手，只输出 JSON。'
    );

    try {
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      const cleaned = jsonMatch ? jsonMatch[1].trim() : extractJsonText(raw);
      const parsed = JSON.parse(cleaned) as { scope?: string; reason?: string };
      const scope = this.normalizeScope(parsed.scope);
      return {
        scope,
        reason: parsed.reason ?? `LLM 二次确认范围为 ${scope}`,
      };
    } catch {
      return { scope: 'local', reason: 'LLM 分类解析失败，按局部修改处理' };
    }
  }

  private normalizeScope(scope: unknown): IssueScope {
    const valid: IssueScope[] = ['trivial', 'local', 'cross-file', 'needs-clarification'];
    if (typeof scope === 'string' && valid.includes(scope as IssueScope)) {
      return scope as IssueScope;
    }
    return 'local';
  }
}
