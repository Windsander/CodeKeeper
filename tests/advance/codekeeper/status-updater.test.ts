import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateStatus, buildProjectStatus } from '../../../src/advance/codekeeper/status-updater';

describe('updateStatus', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cka-st-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('应写入 status.json', () => {
    const status = buildProjectStatus({
      projectId: 'p1',
      lastScannedAt: 1000,
      scanStatus: 'success',
      pendingCount: 2,
      archivedCount: 5,
      ignoredCount: 1,
      suggestionCount: 1,
    });
    updateStatus({ projectRoot: tmp, status });
    const content = readFileSync(join(tmp, '.codekeeper', 'status.json'), 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.projectId).toBe('p1');
    expect(parsed.healthScore).toBe(0.75);
    expect(parsed.totalCount).toBe(8);
    expect(parsed.lastScannedAtIso).toBe('1970-01-01T00:00:01.000Z');
    expect(parsed.scanStatus).toBe('success');
  });

  it('应原子写入 status.json，不残留 tmp 文件', () => {
    const status = buildProjectStatus({
      projectId: 'p2',
      lastScannedAt: 2000,
      scanStatus: 'success',
      pendingCount: 0,
      archivedCount: 0,
      ignoredCount: 0,
      suggestionCount: 0,
    });
    updateStatus({ projectRoot: tmp, status });
    expect(existsSync(join(tmp, '.codekeeper', 'status.json'))).toBe(true);
    expect(existsSync(join(tmp, '.codekeeper', 'status.json.tmp'))).toBe(false);
  });
});

describe('buildProjectStatus', () => {
  it('空项目健康度为 1', () => {
    const status = buildProjectStatus({
      projectId: 'p3',
      lastScannedAt: 0,
      scanStatus: 'success',
      pendingCount: 0,
      archivedCount: 0,
      ignoredCount: 0,
      suggestionCount: 0,
    });
    expect(status.healthScore).toBe(1);
    expect(status.totalCount).toBe(0);
  });

  it('应正确计算健康度并携带 schema 版本', () => {
    const status = buildProjectStatus({
      projectId: 'p4',
      lastScannedAt: 0,
      scanStatus: 'partial',
      pendingCount: 1,
      archivedCount: 3,
      ignoredCount: 0,
      suggestionCount: 2,
    });
    expect(status.healthScore).toBe(0.75);
    expect(status.schemaVersion).toBe(1);
    expect(status.scanStatus).toBe('partial');
  });
});
