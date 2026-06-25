import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { everosMemorySearch } from '../../../../src/advance/classic/memory/everos-api.js';
import { MemoryClient } from '../../../../src/advance/classic/memory/memory-client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const mockContext = {
  appId: 'codekeeper-advance',
  projectId: 'p1',
  agentId: 'reviewer',
  userId: 'codekeeper-system',
  sessionId: 'reviewer-p1-1',
};

describe('everosMemorySearch', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('解析 agent_cases 并按 score 降序返回', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => '',
      json: async () => ({
        request_id: 'req-1',
        data: {
          agent_cases: [
            {
              id: 'ac-1',
              agent_id: 'reviewer',
              app_id: 'codekeeper-advance',
              project_id: 'p1',
              session_id: 's1',
              task_intent: '评审',
              approach: '建议严格类型',
              key_insight: '项目偏好 TypeScript 严格模式',
              quality_score: 0.8,
              timestamp: '2026-01-01T00:00:00Z',
              score: 0.9,
            },
            {
              id: 'ac-2',
              agent_id: 'reviewer',
              app_id: 'codekeeper-advance',
              project_id: 'p1',
              session_id: 's2',
              task_intent: '',
              key_insight: null,
              approach: '',
              timestamp: '2026-01-02T00:00:00Z',
              score: 0.5,
            },
          ],
          episodes: [],
          agent_skills: [],
          profiles: [],
          unprocessed_messages: [],
        },
      }),
    } as Response));

    const result = await everosMemorySearch('http://127.0.0.1:8000', {
      appId: 'codekeeper-advance',
      projectId: 'p1',
      owner: { kind: 'agent', agentId: 'reviewer' },
      query: 'TypeScript strict',
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].content).toBe('项目偏好 TypeScript 严格模式');
    expect(result.items[0].type).toBe('agent_case');
    expect(result.items[0].score).toBe(0.9);
  });

  it('解析 episodes 与 profiles', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => '',
      json: async () => ({
        request_id: 'req-2',
        data: {
          agent_cases: [],
          episodes: [
            {
              id: 'ep-1',
              user_id: 'alice',
              app_id: 'codekeeper-advance',
              project_id: 'p1',
              session_id: 's1',
              summary: 'Alice 偏好小步提交',
              episode: 'Alice 偏好小步提交，重视单测覆盖。',
              subject: 'Alice 的偏好',
              timestamp: '2026-01-01T00:00:00Z',
              score: 0.85,
            },
          ],
          agent_skills: [],
          profiles: [
            {
              id: 'profile-1',
              user_id: 'alice',
              app_id: 'codekeeper-advance',
              project_id: 'p1',
              profile_data: { preferred_language: 'TypeScript', strict_mode: true },
            },
          ],
          unprocessed_messages: [],
        },
      }),
    } as Response));

    const result = await everosMemorySearch('http://127.0.0.1:8000', {
      appId: 'codekeeper-advance',
      projectId: 'p1',
      owner: { kind: 'user', userId: 'alice' },
      query: '偏好',
    });

    expect(result.items).toHaveLength(2);
    const episode = result.items.find((i) => i.type === 'episode');
    expect(episode?.content).toBe('Alice 偏好小步提交');
    const profile = result.items.find((i) => i.type === 'profile');
    expect(profile?.content).toContain('preferred_language');
  });
});

describe('MemoryClient 召回方法', () => {
  let client: MemoryClient;
  let callToolSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new MemoryClient({ mcpUrl: 'http://127.0.0.1:9999', context: mockContext });
    callToolSpy = vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ results: ['历史评审经验 A', '历史评审经验 B'] }) }],
    });
  });

  afterEach(() => {
    callToolSpy.mockRestore();
  });

  it('recallForReview 解析并返回 results', async () => {
    const results = await client.recallForReview('TypeScript');
    expect(results).toEqual(['历史评审经验 A', '历史评审经验 B']);
    expect(callToolSpy).toHaveBeenCalledWith({
      name: 'recall_for_review',
      arguments: { context: mockContext, query: 'TypeScript' },
    });
  });

  it('recallUserPreferences 传入 userId 与 query', async () => {
    const results = await client.recallUserPreferences('alice', '偏好');
    expect(results).toEqual(['历史评审经验 A', '历史评审经验 B']);
    expect(callToolSpy).toHaveBeenCalledWith({
      name: 'recall_user_preferences',
      arguments: { context: mockContext, userId: 'alice', query: '偏好' },
    });
  });

  it('解析失败时返回空数组', async () => {
    callToolSpy.mockResolvedValue({ content: [{ type: 'text', text: 'not-json' }] });
    const results = await client.recallProjectKnowledge('API');
    expect(results).toEqual([]);
  });
});
