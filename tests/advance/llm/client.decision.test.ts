import { describe, it, expect } from 'vitest';
import { LlmClient, LlmDecisionError } from '../../../src/advance/llm/client.js';
import type { ToolDefinition } from '../../../src/advance/llm/tool-types.js';

describe('LlmClient.completeDecision', () => {
  const recallTool: ToolDefinition = {
    name: 'recall_decision',
    description: '记忆查询决策',
    input_schema: { type: 'object', properties: {}, additionalProperties: true },
  };

  it('返回单个允许的 tool call', async () => {
    const client = new LlmClient({
      apiKey: 'test',
      mock: {
        toolResponses: [
          {
            toolCalls: [
              {
                id: 'call-1',
                name: 'recall_decision',
                input: { needsRecall: false, queries: [], reason: '不需要' },
              },
            ],
            stopReason: 'tool_use',
          },
        ],
      },
    });
    const result = await client.completeDecision([recallTool], 'prompt');
    expect(result.name).toBe('recall_decision');
    expect(result.input.needsRecall).toBe(false);
  });

  it('无 tool calls 时抛 no_tool_calls', async () => {
    const client = new LlmClient({ apiKey: 'test', mock: { response: 'hi' } });
    await expect(client.completeDecision([recallTool], 'p')).rejects.toThrow(LlmDecisionError);
  });

  it('多个 tool calls 时抛 multiple_tool_calls', async () => {
    const client = new LlmClient({
      apiKey: 'test',
      mock: {
        toolResponses: [
          {
            toolCalls: [
              { id: '1', name: 'a', input: {} },
              { id: '2', name: 'b', input: {} },
            ],
          },
        ],
      },
    });
    await expect(client.completeDecision([recallTool], 'p')).rejects.toThrow(LlmDecisionError);
  });

  it('白名单外工具抛 unexpected_tool_name', async () => {
    const client = new LlmClient({
      apiKey: 'test',
      mock: {
        toolResponses: [{ toolCalls: [{ id: '1', name: 'other', input: {} }] }],
      },
    });
    await expect(client.completeDecision([recallTool], 'p')).rejects.toThrow(LlmDecisionError);
  });
});
