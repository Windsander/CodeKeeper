import { describe, it, expect, vi } from 'vitest';
import { everosMemoryGet, extractOwnersFromGetResult } from '../../../../src/advance/classic/memory/everos-api.js';

describe('everosMemoryGet', () => {
  it('按 user_id 请求 episode 类型', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(''),
      json: vi.fn().mockResolvedValue({
        data: { episodes: [], profiles: [], agent_cases: [], agent_skills: [], total_count: 0 },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await everosMemoryGet({
      everosUrl: 'http://127.0.0.1:8000',
      appId: 'codekeeper-advance',
      projectId: 'proj-a',
      ownerKind: 'user',
      ownerId: 'alice',
      memoryType: 'episode',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      app_id: 'codekeeper-advance',
      project_id: 'proj-a',
      user_id: 'alice',
      memory_type: 'episode',
    });
  });

  it('extractOwnersFromGetResult 收集 users 和 agents', () => {
    const result = {
      episodes: [{ user_id: 'alice', sender_ids: ['bob'] }],
      profiles: [{ user_id: 'alice' }],
      agent_cases: [{ agent_id: 'reviewer' }],
      agent_skills: [{ agent_id: 'maintainer' }],
      total_count: 4,
    };
    const { users, agents } = extractOwnersFromGetResult(result as any);
    expect([...users]).toEqual(expect.arrayContaining(['alice', 'bob']));
    expect([...agents]).toEqual(expect.arrayContaining(['reviewer', 'maintainer']));
  });
});
