import Anthropic from '@anthropic-ai/sdk';

export interface LlmClientOptions {
  /** API Key；mock 模式下可为任意字符串 */
  apiKey: string;
  /** 模型名称 */
  model?: string;
  /** 最大 token */
  maxTokens?: number;
  /** mock 模式配置，用于测试；responses 支持按调用顺序返回不同结果 */
  mock?: { response?: string; responses?: string[]; error?: Error };
}

/**
 * LLM 调用封装，支持真实 Anthropic API 与 mock 模式
 */
export class LlmClient {
  private anthropic?: Anthropic;
  private model: string;
  private maxTokens: number;
  private mock?: LlmClientOptions['mock'];
  private mockCallIndex = 0;

  constructor(options: LlmClientOptions) {
    this.model = options.model ?? 'claude-3-5-sonnet-20241022';
    this.maxTokens = options.maxTokens ?? 1024;
    this.mock = options.mock;
    if (!this.mock) {
      this.anthropic = new Anthropic({ apiKey: options.apiKey });
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

    if (!this.anthropic) {
      throw new Error('LLM client 未初始化');
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
      throw new Error(`[LlmClient] ${message}`);
    }
  }
}
