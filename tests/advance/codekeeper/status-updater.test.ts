import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateStatus } from '../../../src/advance/codekeeper/status-updater';
import type { ProjectStatus } from '../../../src/advance/types';

describe('updateStatus', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cka-st-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('应写入 status.json', () => {
    const status: ProjectStatus = {
      projectId: 'p1',
      lastScannedAt: 1000,
      pendingCount: 2,
      archivedCount: 5,
      ignoredCount: 1,
      healthScore: 0.8,
      suggestionCount: 1,
    };
    updateStatus({ projectRoot: tmp, status });
    const content = readFileSync(join(tmp, '.codekeeper', 'status.json'), 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.projectId).toBe('p1');
    expect(parsed.healthScore).toBe(0.8);
  });
});
