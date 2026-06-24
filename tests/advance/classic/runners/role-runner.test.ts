import { describe, it, expect, vi } from 'vitest';
import { createRoleRunner } from '../../../../src/advance/classic/runners/role-runner.js';
import { ReviewerRunner } from '../../../../src/advance/classic/runners/reviewer-runner.js';
import { MaintainerRunner } from '../../../../src/advance/classic/runners/maintainer-runner.js';

const mockLlmClient = {
  complete: vi.fn(),
} as unknown as import('../../../../src/advance/llm/client.js').LlmClient;

describe('createRoleRunner', () => {
  it('reviewer 返回 ReviewerRunner', () => {
    expect(createRoleRunner('reviewer', mockLlmClient)).toBeInstanceOf(ReviewerRunner);
  });

  it('maintainer 返回 MaintainerRunner', () => {
    expect(createRoleRunner('maintainer', mockLlmClient)).toBeInstanceOf(MaintainerRunner);
  });
});
