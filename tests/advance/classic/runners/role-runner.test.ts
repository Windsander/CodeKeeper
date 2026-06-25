import { describe, it, expect, vi } from 'vitest';
import { createRoleRunner } from '../../../../src/advance/classic/runners/role-runner.js';
import { ReviewerRunner } from '../../../../src/advance/classic/runners/reviewer-runner.js';
import { MaintainerRunner } from '../../../../src/advance/classic/runners/maintainer-runner.js';
import { ArchiverRunner } from '../../../../src/advance/classic/runners/archiver-runner.js';

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
