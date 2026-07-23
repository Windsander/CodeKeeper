import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitLabClient } from '../../src/gitlab/client.js';
import type { ProjectConfig } from '../../src/types.js';

function makeClient(): GitLabClient {
  return new GitLabClient({
    gitlab: {
      baseUrl: 'https://git.example.invalid',
      projectPath: 'group/project',
      token: 'test-token',
    },
  } as ProjectConfig);
}

function okJson(value: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(value),
    text: vi.fn().mockResolvedValue(''),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitLabClient 列表分页', () => {
  it('notes 超过 100 条时读取全部分页', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
    const secondPage = [{ id: 101 }, { id: 102 }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(firstPage))
      .mockResolvedValueOnce(okJson(secondPage));
    vi.stubGlobal('fetch', fetchMock);

    const notes = await makeClient().getMergeRequestNotes(7);

    expect(notes).toHaveLength(102);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('per_page=100&page=1');
    expect(String(fetchMock.mock.calls[1][0])).toContain('per_page=100&page=2');
  });

  it('discussions 超过 100 条时读取全部分页', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `discussion-${index + 1}`,
      notes: [],
    }));
    const secondPage = [{ id: 'discussion-101', notes: [] }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(firstPage))
      .mockResolvedValueOnce(okJson(secondPage));
    vi.stubGlobal('fetch', fetchMock);

    const discussions = await makeClient().getMergeRequestDiscussions(8);

    expect(discussions).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('per_page=100&page=1');
    expect(String(fetchMock.mock.calls[1][0])).toContain('per_page=100&page=2');
  });
});
