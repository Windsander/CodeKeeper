import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  getStatePath,
  loadState,
  saveState,
  type MrAgentState,
} from '../../../../../src/advance/classic/runners/shared/state-utils.js';
import type { Project } from '../../../../../src/advance/types.js';

describe('state-utils 角色隔离保存', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function makeProject(): Project {
    root = mkdtempSync(join(tmpdir(), 'state-owner-'));
    return {
      id: 'project-example',
      rootPath: root,
      archiveRoot: join(root, 'archive'),
      name: '示例项目',
      registeredAt: Date.now(),
      lastScannedAt: null,
    };
  }

  it('Reviewer、Maintainer、Archiver 保存时不会互相覆盖状态', () => {
    const project = makeProject();
    const reviewerState: MrAgentState = {
      version: 1,
      discussions: {
        'feature/example:main': [
          {
            findingKey: 'src/example.ts:12:generic',
            discussionId: 'discussion-example',
            file: 'src/example.ts',
            line: 12,
            severity: 'HIGH',
            resolved: false,
          },
        ],
      },
      interactiveThreads: {},
      reviewState: {
        'feature/example:main': {
          findingsHash: 'review-hash',
          findingsKeys: ['src/example.ts:12:generic'],
          reviewedAt: 1,
        },
      },
    };
    saveState(project, reviewerState, 'reviewer');

    const maintainerState = loadState(project);
    maintainerState.maintainerThreadState = {
      'discussion-example': {
        decisions: {},
        lastReviewerNoteAt: 0,
        lastHumanNoteAt: 0,
      },
    };
    maintainerState.processedDiscussions = {
      'discussion-example': { noteCount: 1, processedAt: 2 },
    };
    saveState(project, maintainerState, 'maintainer');

    const archiverState = loadState(project);
    archiverState.archiverState = {
      sourceFingerprint: 'fingerprint',
      items: {},
      updatedAt: 3,
    };
    saveState(project, archiverState, 'archiver');

    const combined = loadState(project);
    expect(combined.discussions['feature/example:main']).toHaveLength(1);
    expect(combined.reviewState?.['feature/example:main']?.findingsHash).toBe('review-hash');
    expect(combined.maintainerThreadState?.['discussion-example']).toBeDefined();
    expect(combined.processedDiscussions?.['discussion-example']?.noteCount).toBe(1);
    expect(combined.archiverState?.sourceFingerprint).toBe('fingerprint');
    expect(existsSync(`${getStatePath(project)}.lock`)).toBe(false);
  });

  it('正式状态损坏时保留可解析备份', () => {
    const project = makeProject();
    const state: MrAgentState = {
      version: 1,
      discussions: {},
      interactiveThreads: {},
      reviewerThreadState: {},
    };
    saveState(project, state, 'reviewer');
    saveState(project, { ...state, discussions: { next: [] } }, 'reviewer');

    const path = getStatePath(project);
    const backup = readFileSync(`${path}.bak`, 'utf-8');
    expect(JSON.parse(backup).discussions).toEqual({});

    writeFileSync(path, '{ invalid json', 'utf-8');
    const restored = loadState(project);
    expect(restored.discussions).toEqual({});

    saveState(project, { ...restored, discussions: { recovered: [] } }, 'reviewer');
    expect(loadState(project).discussions).toEqual({ recovered: [] });
    expect(JSON.parse(readFileSync(`${path}.bak`, 'utf-8')).discussions).toEqual({});
  });
});
