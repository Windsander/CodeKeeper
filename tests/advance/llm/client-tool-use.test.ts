import { describe, it, expect } from 'vitest';
import { LlmClient } from '../../../src/advance/llm/client.js';
import type { ToolDefinition } from '../../../src/advance/llm/tool-types.js';

const tools: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'read',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

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
