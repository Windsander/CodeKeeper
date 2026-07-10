/**
 * LLM 工具调用相关类型
 *
 * 为 LlmClient 提供统一的 tool definition / tool call / tool result 抽象，
 * 屏蔽 Anthropic tool_use 与 OpenAI function calling 的差异。
 */

export interface ToolDefinition {
  /** 工具唯一名称 */
  name: string;
  /** 工具功能描述 */
  description: string;
  /** 输入参数 JSON Schema */
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolCall {
  /** 本次 tool call 的唯一标识 */
  id: string;
  /** 工具名 */
  name: string;
  /** 解析后的输入参数 */
  input: Record<string, unknown>;
}

export interface ToolResult {
  /** 对应 tool call 的 id */
  tool_use_id: string;
  /** 工具返回内容，建议为 JSON 字符串 */
  content: string;
  /** 是否为错误结果 */
  is_error?: boolean;
}

export type LlmMessageRole = 'user' | 'assistant';

export type LlmMessageContent =
  | { type: 'text'; text: string }
  | ToolCall
  | ToolResult;

export interface LlmMessage {
  role: LlmMessageRole;
  content: string | LlmMessageContent[];
}

export type ToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }
  | { type: 'none' };

export interface CompleteWithToolsOptions {
  system?: string;
  maxTokens?: number;
  toolChoice?: ToolChoice;
}

export interface CompleteWithToolsResult {
  /** assistant 文本内容 */
  content: string;
  /** assistant 请求调用的工具列表 */
  toolCalls: ToolCall[];
  /** 模型停止原因 */
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | string;
}
