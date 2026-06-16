import Anthropic from '@anthropic-ai/sdk';

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
  mock?: { response?: string; responses?: string[]; error?: Error };
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

  constructor(options: LlmClientOptions) {
    this.apiKey = options.apiKey;
    this.provider = options.provider ?? this.inferProvider(options.baseURL);
    this.baseURL = options.baseURL;
    this.model = options.model ?? this.defaultModel();
    this.headers = options.headers ?? {};
    this.maxTokens = options.maxTokens ?? 1024;
    this.mock = options.mock;
    this.minRequestInterval = options.minRequestInterval ?? 6000;
    if (!this.mock && this.provider === 'anthropic') {
      this.anthropic = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL });
    }
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

    const maxRetries = 5;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.respectRateLimit();
        if (this.provider === 'openai') {
          return await this.completeOpenAI(prompt, system);
        }
        return await this.completeAnthropic(prompt, system);
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

      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[LlmClient:anthropic] ${message}`);
    }
  }

  private async completeOpenAI(prompt: string, system?: string): Promise<string> {
    const url = this.baseURL ?? 'https://api.openai.com/v1/chat/completions';
    const messages: Array<{ role: string; content: string }> = [];
    if (system) {
      messages.push({ role: 'system', content: system });
    }
    messages.push({ role: 'user', content: prompt });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: this.maxTokens,
          stream: false,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      return String(content).trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[LlmClient:openai] ${message}`);
    }
  }
}
