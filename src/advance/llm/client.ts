import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../core/logger';
import { logMemorySnapshot } from '../classic/utils/memory-snapshot.js';
import { extractJsonText } from '../classic/utils/json-extraction.js';

import type { ToolCall, ToolDefinition, LlmMessage, CompleteWithToolsOptions, CompleteWithToolsResult, ToolResult } from './tool-types.js';

/**
 * 决策工具调用未按约定返回时抛出的异常。
 */
export class LlmDecisionError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'no_tool_calls'
      | 'multiple_tool_calls'
      | 'unexpected_tool_name'
      | 'invalid_input'
      | 'provider_error'
  ) {
    super(message);
  }
}

/** 单轮 complete 响应允许的最大字符数，防止异常大响应撑爆堆内存 */
const MAX_COMPLETE_RESPONSE_CHARS = 200_000;

export type LlmProvider = 'anthropic' | 'openai';

export interface LlmClientOptions {
  /** API Key */
  apiKey: string;
  /** 服务提供商：anthropic 或 openai 兼容 */
  provider?: LlmProvider;
  /** 自定义 API Base URL */
  baseURL?: string;
  /** 模型名称 */
  model?: string;
  /** 自定义请求头（JSON 对象） */
  headers?: Record<string, string>;
  /** 最大 token */
  maxTokens?: number;
  /** mock 模式配置，用于测试；responses 支持按调用顺序返回不同结果 */
  mock?: {
    response?: string;
    responses?: string[];
    error?: Error;
    toolResponses?: Array<{
      content?: string;
      toolCalls: ToolCall[];
      stopReason?: string;
    }>;
  };
  /** 两次 LLM 请求之间的最小间隔（毫秒），默认 1000ms */
  minRequestInterval?: number;
}

/**
 * LLM 调用封装，支持 Anthropic API 与 OpenAI 兼容 API
 */
export class LlmClient {
  private apiKey: string;
  private anthropic?: Anthropic;
  private provider: LlmProvider;
  private baseURL?: string;
  private model: string;
  private headers: Record<string, string>;
  private maxTokens: number;
  private mock?: LlmClientOptions['mock'];
  private mockCallIndex = 0;
  private minRequestInterval: number;
  private lastRequestTime = 0;
  private fallbackId = 0;

  constructor(options: LlmClientOptions) {
    this.apiKey = options.apiKey;
    this.provider = options.provider ?? this.inferProvider(options.baseURL);
    this.baseURL = options.baseURL;
    this.model = options.model ?? this.defaultModel();
    this.headers = options.headers ?? {};
    this.maxTokens = options.maxTokens ?? 2048;
    this.mock = options.mock;
    this.minRequestInterval = options.minRequestInterval ?? 6000;
    if (!this.mock && this.provider === 'anthropic') {
      this.anthropic = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL });
    }
  }

  /**
   * 发送支持工具调用的多轮对话请求
   */
  async completeWithTools(
    messages: LlmMessage[],
    tools: ToolDefinition[],
    options?: CompleteWithToolsOptions
  ): Promise<CompleteWithToolsResult> {
    if (this.mock) {
      if (this.mock.error) {
        throw this.mock.error;
      }
      if (this.mock.toolResponses && this.mock.toolResponses.length > 0) {
        const idx = this.mockCallIndex % this.mock.toolResponses.length;
        this.mockCallIndex++;
        const r = this.mock.toolResponses[idx];
        return {
          content: r.content ?? '',
          toolCalls: r.toolCalls,
          stopReason: r.stopReason ?? 'tool_use',
        };
      }
      return {
        content: this.mock.response ?? '',
        toolCalls: [],
        stopReason: 'end_turn',
      };
    }

    const maxRetries = 5;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.respectRateLimit();
        if (this.provider === 'openai') {
          return await this.completeOpenAIWithTools(messages, tools, options);
        }
        return await this.completeAnthropicWithTools(messages, tools, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isRateLimit = message.includes('429') || message.includes('Too many requests');
        if (!isRateLimit || attempt === maxRetries) {
          const prefix = `[LlmClient:${this.provider}]`;
          const cleanMessage = message.startsWith(prefix) ? message.slice(prefix.length).trim() : message;
          throw new Error(`${prefix} ${cleanMessage}`);
        }
        const delay = Math.min(2000 * 2 ** attempt, 60000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error(`[LlmClient:${this.provider}] 重试后仍失败`);
  }

  /**
   * 强制模型从给定的决策工具中选择一个并调用。
   * 返回解析后的 ToolCall，不满足条件时抛 LlmDecisionError。
   */
  async completeDecision(
    tools: ToolDefinition[],
    prompt: string,
    system?: string
  ): Promise<ToolCall> {
    if (this.mock) {
      if (this.mock.error) {
        throw this.mock.error;
      }
      if (this.mock.toolResponses && this.mock.toolResponses.length > 0) {
        const idx = this.mockCallIndex % this.mock.toolResponses.length;
        this.mockCallIndex++;
        const r = this.mock.toolResponses[idx];
        const valid = r.toolCalls.filter((tc) => tools.some((t) => t.name === tc.name));
        if (valid.length === 1) {
          return valid[0];
        }
        // mock 未返回有效 tool calls 时，尝试从 content 兜底解析（模拟 OpenAI 兼容端点行为）
        if (valid.length === 0 && r.content?.trim()) {
          const fallback = this.tryParseDecisionFromContent(tools, r.content);
          if (fallback) return fallback;
        }
        if (valid.length === 0) {
          throw new LlmDecisionError('mock 未返回允许的决策工具', 'no_tool_calls');
        }
        throw new LlmDecisionError(`mock 返回了 ${valid.length} 个允许工具，期望 1 个`, 'multiple_tool_calls');
      }
      // 支持 mock.response 直接模拟 content 兜底
      if (this.mock.response?.trim()) {
        const fallback = this.tryParseDecisionFromContent(tools, this.mock.response);
        if (fallback) return fallback;
      }
      throw new LlmDecisionError('mock 模式下 completeDecision 需要配置 mock.toolResponses', 'no_tool_calls');
    }

    const result = await this.completeWithTools(
      [{ role: 'user', content: prompt }],
      tools,
      { system, toolChoice: { type: 'any' }, maxTokens: this.maxTokens }
    );

    // 兜底：部分 OpenAI 兼容端点不严格遵循 tool_choice=required，把 JSON 放到了 content 里
    if (result.toolCalls.length === 0 && result.content.trim()) {
      const fallback = this.tryParseDecisionFromContent(tools, result.content);
      if (fallback) return fallback;
    }

    if (result.toolCalls.length === 0) {
      throw new LlmDecisionError('LLM 未返回任何工具调用', 'no_tool_calls');
    }
    if (result.toolCalls.length > 1) {
      throw new LlmDecisionError(`LLM 返回了 ${result.toolCalls.length} 个工具调用，期望 1 个`, 'multiple_tool_calls');
    }

    const toolCall = result.toolCalls[0];
    if (!tools.some((t) => t.name === toolCall.name)) {
      throw new LlmDecisionError(`LLM 调用了未允许的工具: ${toolCall.name}`, 'unexpected_tool_name');
    }
    if (!toolCall.input || typeof toolCall.input !== 'object' || Array.isArray(toolCall.input)) {
      throw new LlmDecisionError(`工具 ${toolCall.name} 的输入不是合法对象`, 'invalid_input');
    }
    return toolCall;
  }

  private async completeAnthropicWithTools(
    messages: LlmMessage[],
    tools: ToolDefinition[],
    options?: CompleteWithToolsOptions
  ): Promise<CompleteWithToolsResult> {
    if (!this.anthropic) {
      throw new Error('Anthropic client 未初始化');
    }

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      system: options?.system,
      messages: this.toAnthropicMessages(messages),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
      tool_choice: options?.toolChoice ? this.toAnthropicToolChoice(options.toolChoice) : undefined,
    });

    const content = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');

    const toolCalls: ToolCall[] = response.content
      .filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use')
      .map((c) => ({ id: c.id, name: c.name, input: c.input as Record<string, unknown> }));

    logger.debug({ model: this.model, contentLength: content.length, toolCalls: toolCalls.length }, 'Anthropic tool-use 响应');
    console.log(`[LlmClient] completeWithTools Anthropic content 长度=${content.length}, toolCalls=${toolCalls.length}`);

    return {
      content,
      toolCalls,
      stopReason: response.stop_reason ?? 'end_turn',
    };
  }

  private async completeOpenAIWithTools(
    messages: LlmMessage[],
    tools: ToolDefinition[],
    options?: CompleteWithToolsOptions
  ): Promise<CompleteWithToolsResult> {
    const url = this.baseURL ?? 'https://api.openai.com/v1/chat/completions';
    const bodyMessages = this.toOpenAIMessages(messages);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify({
        model: this.model,
        messages: bodyMessages,
        max_tokens: options?.maxTokens ?? this.maxTokens,
        stream: false,
        tools: tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        })),
        tool_choice: options?.toolChoice ? this.toOpenAIToolChoice(options.toolChoice) : undefined,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          reasoning_content?: string;
          tool_calls?: Array<{
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string;
      }>;
    };

    const message = data.choices?.[0]?.message;
    const content = message?.content ?? message?.reasoning_content ?? '';
    const toolCalls: ToolCall[] = (message?.tool_calls ?? [])
      .filter((tc) => tc.type === 'function')
      .map((tc) => ({
        id: tc.id ?? '',
        name: tc.function?.name ?? '',
        input: this.safeParseJson(tc.function?.arguments ?? '{}'),
      }));

    logger.debug(
      { status: response.status, model: this.model, contentLength: content.length, toolCalls: toolCalls.length },
      'OpenAI tool-use 响应'
    );
    console.log(`[LlmClient] completeWithTools OpenAI content 长度=${content.length}, toolCalls=${toolCalls.length}`);

    return {
      content: String(content),
      toolCalls,
      stopReason: data.choices?.[0]?.finish_reason ?? 'end_turn',
    };
  }

  private toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
    return messages.map((m) => {
      if (typeof m.content === 'string') {
        return { role: m.role, content: m.content };
      }

      const contentBlocks: Anthropic.MessageParam['content'] = m.content.map((part) => {
        if ('tool_use_id' in part) {
          const result = part as ToolResult;
          return {
            type: 'tool_result',
            tool_use_id: result.tool_use_id,
            content: result.content,
            is_error: result.is_error,
          };
        }
        if ('name' in part) {
          const call = part as ToolCall;
          return { type: 'tool_use', id: call.id, name: call.name, input: call.input };
        }
        const text = part as { type: 'text'; text: string };
        return { type: 'text', text: text.text };
      });

      return { role: m.role, content: contentBlocks };
    });
  }

  private toAnthropicToolChoice(toolChoice: CompleteWithToolsOptions['toolChoice']): Anthropic.ToolChoice {
    if (!toolChoice) return { type: 'auto' };
    switch (toolChoice.type) {
      case 'any':
        return { type: 'any' };
      case 'none':
        return { type: 'none' };
      case 'tool':
        return { type: 'tool', name: toolChoice.name };
      default:
        return { type: 'auto' };
    }
  }

  private toOpenAIMessages(messages: LlmMessage[]): Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }> {
    const result: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }> = [];

    for (const m of messages) {
      if (typeof m.content === 'string') {
        result.push({ role: m.role, content: m.content });
        continue;
      }

      if (m.role === 'assistant') {
        const textParts = m.content
          .filter((part): part is { type: 'text'; text: string } => 'type' in part && part.type === 'text')
          .map((part) => part.text)
          .join('\n');
        const toolCalls = m.content
          .filter((part): part is ToolCall => 'name' in part && 'id' in part)
          .map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.input),
            },
          }));
        result.push({
          role: 'assistant',
          content: textParts || '',
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        });
        continue;
      }

      // user 消息：文本部分合并为一条，工具结果拆分为多条 role=tool 消息
      const textParts = m.content
        .filter((part): part is { type: 'text'; text: string } => 'type' in part && part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      if (textParts) {
        result.push({ role: 'user', content: textParts });
      }
      const toolResults = m.content.filter((part): part is ToolResult => 'tool_use_id' in part);
      for (const tr of toolResults) {
        result.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: tr.content,
        });
      }
    }

    return result;
  }

  private toOpenAIToolChoice(toolChoice: CompleteWithToolsOptions['toolChoice']): unknown {
    if (!toolChoice) return 'auto';
    switch (toolChoice.type) {
      case 'any':
        return 'required'; // OpenAI 中 required 强制模型至少调用一个工具
      case 'none':
        return 'none';
      case 'tool':
        return { type: 'function', function: { name: toolChoice.name } };
      default:
        return 'auto';
    }
  }

  private tryParseDecisionFromContent(tools: ToolDefinition[], content: string): ToolCall | null {
    const extracted = extractJsonText(content);
    const parsed = this.safeParseJson(extracted);
    if (Object.keys(parsed).length === 0) {
      return null;
    }
    if (tools.length === 1) {
      console.log(`[LlmClient] completeDecision 从 content 兜底解析为 ${tools[0].name}`);
      return {
        id: `fallback-${this.fallbackId++}`,
        name: tools[0].name,
        input: parsed,
      };
    }
    // 多工具场景：尝试识别 { name, input } 格式
    const parsedName = parsed.name;
    if (typeof parsedName === 'string' && tools.some((t) => t.name === parsedName)) {
      const input = parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input)
        ? (parsed.input as Record<string, unknown>)
        : parsed;
      console.log(`[LlmClient] completeDecision 从 content 兜底解析为 ${parsedName}`);
      return {
        id: `fallback-${this.fallbackId++}`,
        name: parsedName,
        input,
      };
    }
    return null;
  }

  private safeParseJson(text: string): Record<string, unknown> {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * 强制以结构化 JSON 工具调用的方式完成请求。
   *
   * 通过 tool_choice 强制模型调用 respond_json 工具，把结果放在工具输入里，
   * 从而绕过部分模型对 "只输出 JSON" 指令不敏感、输出大段解释文字的问题。
   */
  async completeJson(
    prompt: string,
    system?: string,
    schema?: ToolDefinition['input_schema']
  ): Promise<string> {
    if (this.mock) {
      // mock 模式下复用 complete 的返回值，便于现有测试无需额外配置
      return this.complete(prompt, system);
    }

    // OpenAI 兼容接口优先使用 response_format=json_object，比 tool_choice 更可靠
    if (this.provider === 'openai') {
      try {
        const text = await this.completeOpenAIJson(prompt, system);
        if (text) return text;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`[LlmClient] completeJson JSON mode 失败，fallback 到 tool-use: ${message}`);
      }
    }

    const tool: ToolDefinition = {
      name: 'respond_json',
      description: '以符合 JSON 格式的结构化对象输出响应，不要输出任何其他解释文字。',
      input_schema: schema ?? {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
    };

    const result = await this.completeWithTools(
      [{ role: 'user', content: prompt }],
      [tool],
      {
        system,
        toolChoice: { type: 'tool', name: 'respond_json' },
        maxTokens: this.maxTokens,
      }
    );

    if (result.toolCalls.length > 0) {
      const input = result.toolCalls[0].input;
      if (Object.keys(input).length === 0 && result.content.trim()) {
        // 极端兜底：如果模型把 JSON 放到了 content 而非 tool input，尝试复用
        return result.content.trim();
      }
      return JSON.stringify(input);
    }

    // 部分模型/端点不支持强制 tool_choice，退而从 content 中提取 JSON
    const content = result.content.trim();
    if (content) {
      try {
        const extracted = extractJsonText(content);
        const parsed = JSON.parse(extracted);
        if (parsed && typeof parsed === 'object') {
          return extracted;
        }
      } catch {
        // content 不是有效 JSON，尝试一次转换
      }

      const converted = await this.convertProseToJson(content, tool);
      if (converted) return converted;
    }

    throw new Error('LLM 未返回 JSON 工具调用');
  }

  private async completeOpenAIJson(prompt: string, system?: string): Promise<string | null> {
    const messages: Array<{ role: string; content: string }> = [];
    if (system) {
      messages.push({ role: 'system', content: system });
    }
    messages.push({ role: 'user', content: prompt });
    const text = await this.completeOpenAIStream(messages, 'json_object');
    if (!text) return null;
    const extracted = extractJsonText(text);
    const parsed = JSON.parse(extracted);
    if (parsed && typeof parsed === 'object') {
      return extracted;
    }
    return null;
  }

  private async convertProseToJson(prose: string, tool: ToolDefinition): Promise<string | null> {
    const retryPrompt = [
      '你刚才的输出不是严格可解析的 JSON。请把它转换成纯 JSON，只输出 JSON，不要任何解释。',
      '',
      '原始输出：',
      prose,
      '',
      '请输出 JSON：',
    ].join('\n');

    try {
      const result = await this.completeWithTools(
        [{ role: 'user', content: retryPrompt }],
        [tool],
        {
          toolChoice: { type: 'tool', name: 'respond_json' },
          maxTokens: this.maxTokens,
        }
      );

      if (result.toolCalls.length > 0) {
        const input = result.toolCalls[0].input;
        if (Object.keys(input).length > 0) {
          return JSON.stringify(input);
        }
      }

      const content = result.content.trim();
      if (content) {
        const extracted = extractJsonText(content);
        const parsed = JSON.parse(extracted);
        if (parsed && typeof parsed === 'object') {
          return extracted;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[LlmClient] convertProseToJson 失败: ${message}`);
    }
    return null;
  }

  /**
   * 发送单轮 complete 请求，返回模型生成的文本
   */
  async complete(prompt: string, system?: string): Promise<string> {
    if (this.mock) {
      if (this.mock.error) {
        throw this.mock.error;
      }
      if (this.mock.responses && this.mock.responses.length > 0) {
        const idx = this.mockCallIndex % this.mock.responses.length;
        this.mockCallIndex++;
        return this.mock.responses[idx];
      }
      return this.mock.response ?? '';
    }

    console.log(`[LlmClient] complete 开始 provider=${this.provider} model=${this.model} promptLength=${prompt.length}`);
    const startHeap = process.memoryUsage().heapUsed;
    let peakGrowth = 0;
    const interval = setInterval(() => {
      const growth = process.memoryUsage().heapUsed - startHeap;
      if (growth > peakGrowth + 50 * 1024 * 1024) {
        peakGrowth = growth;
        logMemorySnapshot(`LlmClient.complete 进行中 堆增长 ${Math.round(growth / 1024 / 1024)}MB`);
      }
    }, 1000);

    const maxRetries = 5;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.respectRateLimit();
        let result: string;
        if (this.provider === 'openai') {
          result = await this.completeOpenAI(prompt, system);
        } else {
          result = await this.completeAnthropic(prompt, system);
        }
        clearInterval(interval);
        console.log(`[LlmClient] complete prompt 长度=${prompt.length}, response 长度=${result.length}`);
        return result;
      } catch (error) {
        clearInterval(interval);
        const message = error instanceof Error ? error.message : String(error);
        const isRateLimit = message.includes('429') || message.includes('Too many requests');
        if (!isRateLimit || attempt === maxRetries) {
          const prefix = `[LlmClient:${this.provider}]`;
          const cleanMessage = message.startsWith(prefix) ? message.slice(prefix.length).trim() : message;
          throw new Error(`${prefix} ${cleanMessage}`);
        }
        const delay = Math.min(2000 * 2 ** attempt, 60000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    clearInterval(interval);
    throw new Error(`[LlmClient:${this.provider}] 重试后仍失败`);
  }

  private async respectRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minRequestInterval) {
      await new Promise((resolve) => setTimeout(resolve, this.minRequestInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  private inferProvider(baseURL?: string): LlmProvider {
    if (baseURL && baseURL.includes('/chat/completions')) {
      return 'openai';
    }
    return 'anthropic';
  }

  private defaultModel(): string {
    return this.provider === 'openai'
      ? 'gpt-4o-mini'
      : 'claude-3-5-sonnet-20241022';
  }

  private async completeAnthropic(prompt: string, system?: string): Promise<string> {
    if (!this.anthropic) {
      throw new Error('Anthropic client 未初始化');
    }

    try {
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('')
        .trim();
      logger.debug({ model: this.model, contentLength: text.length }, 'Anthropic 响应');
      if (text.length > MAX_COMPLETE_RESPONSE_CHARS) {
        throw new Error(`响应长度 ${text.length} 超过上限 ${MAX_COMPLETE_RESPONSE_CHARS}`);
      }
      if (!text) {
        throw new Error('响应内容为空');
      }
      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[LlmClient:anthropic] ${message}`);
    }
  }

  private async completeOpenAI(prompt: string, system?: string): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];
    if (system) {
      messages.push({ role: 'system', content: system });
    }
    messages.push({ role: 'user', content: prompt });
    return this.completeOpenAIStream(messages);
  }

  private async completeOpenAIStream(
    messages: Array<{ role: string; content: string }>,
    responseFormat?: 'json_object'
  ): Promise<string> {
    const url = this.baseURL ?? 'https://api.openai.com/v1/chat/completions';
    console.log(`[LlmClient] completeOpenAIStream 请求前 model=${this.model} max_tokens=${this.maxTokens}`);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      stream: true,
    };
    if (responseFormat) {
      body.response_format = { type: responseFormat };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify(body),
    });

    console.log(`[LlmClient] completeOpenAIStream 响应 status=${response.status} content-length=${response.headers.get('content-length') ?? 'unknown'}`);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    if (!response.body) {
      throw new Error('流式响应体为空');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let rawPreview = '';
    let chunkCount = 0;
    const maxBufferChars = 1024 * 1024; // 1MB

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount++;
      if (value && value.length > 1024 * 1024) {
        console.log(`[LlmClient] 单 chunk 大小 ${value.length} bytes`);
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > maxBufferChars) {
        reader.cancel().catch(() => undefined);
        throw new Error(`SSE buffer 累积 ${buffer.length} 字符，超过 ${maxBufferChars}，可能后端返回了非 SSE 大响应`);
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        if (rawPreview.length < 2000) {
          rawPreview += data + '\n';
        }
        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{
              delta?: { content?: string; reasoning_content?: string; role?: string };
              finish_reason?: string | null;
            }>;
          };
          const delta = chunk.choices?.[0]?.delta;
          const text = delta?.content ?? delta?.reasoning_content;
          if (text) {
            if (content.length + text.length > MAX_COMPLETE_RESPONSE_CHARS) {
              reader.cancel().catch(() => undefined);
              throw new Error(`流式响应累计长度 ${content.length + text.length} 超过上限 ${MAX_COMPLETE_RESPONSE_CHARS}`);
            }
            content += text;
          }
        } catch {
          // 忽略无法解析的 SSE 行
        }
      }
      if (chunkCount % 100 === 0) {
        logMemorySnapshot(`LlmClient.completeOpenAIStream 已读 ${chunkCount} chunks`);
      }
    }

    console.log(`[LlmClient] completeOpenAIStream 读取完成 chunks=${chunkCount} contentLength=${content.length}`);
    logger.debug(
      { model: this.model, contentLength: content.length, rawPreview: rawPreview.slice(0, 500) },
      'OpenAI 流式响应'
    );
    if (!content) {
      logger.warn(
        { model: this.model, rawPreview: rawPreview.slice(0, 2000) },
        'OpenAI 流式响应内容为空，原始内容前 2000 字符'
      );
      throw new Error('流式响应内容为空');
    }
    return content.trim();
  }
}
