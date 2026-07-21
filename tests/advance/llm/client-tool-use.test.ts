import { describe, it, expect, vi, afterEach } from 'vitest';
import { LlmClient } from '../../../src/advance/llm/client.js';
import type { ToolDefinition } from '../../../src/advance/llm/tool-types.js';

const tools: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'read',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LlmClient.completeWithTools mock', () => {
  it('按 toolResponses 顺序返回 tool call', async () => {
    const client = new LlmClient({
      apiKey: 'test',
      mock: {
        toolResponses: [
          {
            content: '读取文件',
            toolCalls: [{ id: '1', name: 'read_file', input: { relPath: 'src/index.ts' } }],
            stopReason: 'tool_use',
          },
        ],
      },
    });

    const result = await client.completeWithTools([{ role: 'user', content: 'hi' }], tools);

    expect(result.content).toBe('读取文件');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('read_file');
    expect(result.stopReason).toBe('tool_use');
  });

  it('无 toolResponses 时返回空 toolCalls', async () => {
    const client = new LlmClient({
      apiKey: 'test',
      mock: { response: 'hello' },
    });

    const result = await client.completeWithTools([{ role: 'user', content: 'hi' }], tools);

    expect(result.content).toBe('hello');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.stopReason).toBe('end_turn');
  });
});

describe('LlmClient tool-use 响应体上限', () => {
  it('响应体超过 2MB 上限时抛错并取消读取，不再无上限缓冲', async () => {
    // 模拟异常端点：持续灌入 64KB chunk，永不结束
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = encoder.encode('x'.repeat(64 * 1024));
        const timer = setInterval(() => {
          try {
            controller.enqueue(chunk);
          } catch {
            clearInterval(timer);
          }
        }, 0);
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(stream, { status: 200 }))
    );

    const client = new LlmClient({ apiKey: 'test', provider: 'openai', minRequestInterval: 0 });

    await expect(client.completeWithTools([{ role: 'user', content: 'hi' }], tools)).rejects.toThrow(
      '上限'
    );
  });

  it('正常大小响应不受影响，正确解析 tool calls', async () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              { id: '1', type: 'function', function: { name: 'read_file', arguments: '{"relPath":"a.ts"}' } },
            ],
          },
          finish_reason: 'tool_use',
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(body, { status: 200 }))
    );

    const client = new LlmClient({ apiKey: 'test', provider: 'openai', minRequestInterval: 0 });
    const result = await client.completeWithTools([{ role: 'user', content: 'hi' }], tools);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('read_file');
    expect(result.toolCalls[0].input).toEqual({ relPath: 'a.ts' });
  });
});
