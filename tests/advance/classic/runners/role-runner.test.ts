import { describe, it, expect, vi } from 'vitest';
import { createRoleRunner } from '../../../../src/advance/classic/runners/role-runner.js';
import { ReviewerRunner, buildReviewerSessionId } from '../../../../src/advance/classic/runners/reviewer-runner.js';
import { MaintainerRunner, buildMaintainerMrSessionId } from '../../../../src/advance/classic/runners/maintainer-runner.js';
import { ArchiverRunner, buildArchiverSessionId } from '../../../../src/advance/classic/runners/archiver-runner.js';

const mockLlmClient = {
  complete: vi.fn(),
} as unknown as import('../../../../src/advance/llm/client.js').LlmClient;

describe('createRoleRunner', () => {
  it('reviewer 返回 ReviewerRunner', () => {
    expect(createRoleRunner('reviewer', { llmClient: mockLlmClient })).toBeInstanceOf(ReviewerRunner);
  });

  it('maintainer 返回 MaintainerRunner', () => {
    expect(createRoleRunner('maintainer', { llmClient: mockLlmClient })).toBeInstanceOf(MaintainerRunner);
  });

  it('archiver 返回 ArchiverRunner', () => {
    process.env.CK_EVEROS_MCP_URL = 'http://127.0.0.1:9999';
    expect(createRoleRunner('archiver', { llmClient: mockLlmClient, mcpUrl: 'http://127.0.0.1:9999' })).toBeInstanceOf(ArchiverRunner);
  });
});

describe('Runner sessionId 格式', () => {
  it('ReviewerRunner 使用 MR 粒度', () => {
    expect(buildReviewerSessionId('proj-a', 42)).toBe('reviewer-proj-a-mr-42');
  });

  it('MaintainerRunner 修复尝试使用 MR 粒度', () => {
    expect(buildMaintainerMrSessionId('proj-a', 7)).toBe('maintainer-proj-a-mr-7');
  });

  it('ArchiverRunner 使用 8 小时窗口粒度', () => {
    const date = new Date('2026-06-30T05:00:00Z');
    expect(buildArchiverSessionId('proj-a', date)).toBe('archiver-proj-a-2026-06-30-0');
  });
});
