import { describe, it, expect } from 'vitest';
import { createRoleRunner } from '../../../../src/advance/classic/runners/role-runner.js';
import { ReviewerRunner } from '../../../../src/advance/classic/runners/reviewer-runner.js';
import { MaintainerRunner } from '../../../../src/advance/classic/runners/maintainer-runner.js';

describe('createRoleRunner', () => {
  it('reviewer 返回 ReviewerRunner', () => {
    expect(createRoleRunner('reviewer')).toBeInstanceOf(ReviewerRunner);
  });

  it('maintainer 返回 MaintainerRunner', () => {
    expect(createRoleRunner('maintainer')).toBeInstanceOf(MaintainerRunner);
  });
});
