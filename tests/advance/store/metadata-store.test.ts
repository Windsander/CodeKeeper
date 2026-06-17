import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetadataStore } from '../../../src/advance/store/metadata-store';
import type { GitlabConfig, MrReviewConfig, MrReviewState } from '../../../src/advance/types';

describe('MetadataStore', () => {
  let store: MetadataStore;
  let dbPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-store-'));
    dbPath = join(dir, 'test.db');
    store = new MetadataStore(dbPath);
  });

  afterEach(() => {
    store.close();
  });

  it('能注册并查询项目', () => {
    store.registerProject({
      id: '/tmp/proj-a',
      rootPath: '/tmp/proj-a',
      name: 'proj-a',
      registeredAt: 1,
      lastScannedAt: null,
    });
    const projects = store.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('proj-a');
  });

  it('注销项目会级联删除事件与条目', () => {
    store.registerProject({ id: '/tmp/proj-b', rootPath: '/tmp/proj-b', name: 'proj-b', registeredAt: 1, lastScannedAt: null });
    store.insertEvent({ projectId: '/tmp/proj-b', filePath: '/tmp/proj-b/readme.md', type: 'add', timestamp: 2 });
    store.upsertEntry({
      id: '/tmp/proj-b/readme.md@v1',
      projectId: '/tmp/proj-b',
      filePath: '/tmp/proj-b/readme.md',
      contentHash: 'abc',
      status: 'pending',
      createdAt: 3,
      updatedAt: 3,
    });
    store.unregisterProject('/tmp/proj-b');
    expect(store.listProjects()).toHaveLength(0);
    expect(store.listPendingEvents()).toHaveLength(0);
    expect(store.listEntriesByProject('/tmp/proj-b')).toHaveLength(0);
  });

  it('能插入并标记处理事件', () => {
    store.registerProject({ id: '/tmp/proj-c', rootPath: '/tmp/proj-c', name: 'proj-c', registeredAt: 1, lastScannedAt: null });
    store.insertEvent({ projectId: '/tmp/proj-c', filePath: '/tmp/proj-c/a.md', type: 'change', timestamp: 2 });
    const pending = store.listPendingEvents();
    expect(pending).toHaveLength(1);
    store.markEventsProcessed([pending[0].eventId]);
    expect(store.listPendingEvents()).toHaveLength(0);
  });

  // ---------- GitLab 配置测试 ----------

  it('能更新并读取项目 GitLab 配置', () => {
    store.registerProject({ id: '/tmp/proj-git', rootPath: '/tmp/proj-git', name: 'proj-git', registeredAt: 1, lastScannedAt: null });

    const gitlabConfig: GitlabConfig = {
      baseUrl: 'https://gitlab.example.com',
      projectPath: 'group/project',
      token: 'glpat-secret',
      defaultBranch: 'main',
    };
    store.updateProjectGitlabConfig('/tmp/proj-git', gitlabConfig);

    const project = store.getProject('/tmp/proj-git');
    expect(project?.gitlab).toEqual(gitlabConfig);
  });

  // ---------- MR 评审配置测试 ----------

  it('能更新并读取 MR 评审配置', () => {
    store.registerProject({ id: '/tmp/proj-mr', rootPath: '/tmp/proj-mr', name: 'proj-mr', registeredAt: 1, lastScannedAt: null });

    const mrConfig: MrReviewConfig = {
      enabled: true,
      autoMergeMode: 'audit',
      reviewSchedule: '0 9 * * 1-5',
      learningEnabled: true,
      maxAutoMergeRisk: 'MEDIUM',
    };
    store.updateMrReviewConfig('/tmp/proj-mr', mrConfig);

    const project = store.getProject('/tmp/proj-mr');
    expect(project?.mrReview).toEqual(mrConfig);
  });

  // ---------- getMrEnabledProjects 测试 ----------

  it('getMrEnabledProjects 正确过滤启用了 MR 且配置了 GitLab 的项目', () => {
    // 项目 A：同时配置 GitLab 和启用的 MR 评审
    store.registerProject({
      id: '/tmp/proj-a',
      rootPath: '/tmp/proj-a',
      name: 'proj-a',
      registeredAt: 1,
      lastScannedAt: null,
      gitlab: { baseUrl: 'https://gitlab.a.com', projectPath: 'a/p', token: 'tok-a' },
      mrReview: { enabled: true, autoMergeMode: 'full', reviewSchedule: '0 9 * * *', learningEnabled: false, maxAutoMergeRisk: 'LOW' },
    });

    // 项目 B：配置了 GitLab 但 MR 评审未启用
    store.registerProject({
      id: '/tmp/proj-b',
      rootPath: '/tmp/proj-b',
      name: 'proj-b',
      registeredAt: 2,
      lastScannedAt: null,
      gitlab: { baseUrl: 'https://gitlab.b.com', projectPath: 'b/p', token: 'tok-b' },
      mrReview: { enabled: false, autoMergeMode: 'audit', reviewSchedule: '0 10 * * *', learningEnabled: false, maxAutoMergeRisk: 'HIGH' },
    });

    // 项目 C：没有 GitLab 配置
    store.registerProject({ id: '/tmp/proj-c', rootPath: '/tmp/proj-c', name: 'proj-c', registeredAt: 3, lastScannedAt: null });

    const enabled = store.getMrEnabledProjects();
    expect(enabled).toHaveLength(1);
    expect(enabled[0].id).toBe('/tmp/proj-a');
  });

  // ---------- MR 状态 CRUD 测试 ----------

  it('能插入并查询 MR 状态', () => {
    const state: MrReviewState = {
      id: 'mr-001',
      projectId: '/tmp/proj-mr',
      mrIid: 42,
      sourceBranch: 'feature/foo',
      targetBranch: 'main',
      state: 'opened',
      title: 'Add foo feature',
      webUrl: 'https://gitlab.example.com/group/project/-/merge_requests/42',
      findingsJson: JSON.stringify({ issues: [] }),
      riskLevel: 'LOW',
      reviewerCommentsCount: 3,
      unresolvedCommentsCount: 1,
      ciStatus: 'success',
      lastReviewerCommentAt: 1700000000000,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    };

    store.insertOrUpdateMrState(state);

    const retrieved = store.getMrState('/tmp/proj-mr', 42);
    expect(retrieved).toBeDefined();
    expect(retrieved?.mrIid).toBe(42);
    expect(retrieved?.state).toBe('opened');
    expect(retrieved?.title).toBe('Add foo feature');
    expect(retrieved?.riskLevel).toBe('LOW');
    expect(retrieved?.reviewerCommentsCount).toBe(3);
    expect(retrieved?.unresolvedCommentsCount).toBe(1);
  });

  it('能更新已存在的 MR 状态（UPSERT）', () => {
    const state: MrReviewState = {
      id: 'mr-002',
      projectId: '/tmp/proj-mr2',
      mrIid: 7,
      sourceBranch: 'feature/bar',
      targetBranch: 'develop',
      state: 'opened',
      title: 'Initial',
      reviewerCommentsCount: 0,
      unresolvedCommentsCount: 0,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    };

    store.insertOrUpdateMrState(state);

    // 更新同一 MR
    const updatedState: MrReviewState = {
      ...state,
      state: 'merged',
      title: 'Updated title',
      riskLevel: 'MEDIUM',
      reviewerCommentsCount: 5,
      updatedAt: 1700100000000,
    };
    store.insertOrUpdateMrState(updatedState);

    const retrieved = store.getMrState('/tmp/proj-mr2', 7);
    expect(retrieved?.state).toBe('merged');
    expect(retrieved?.title).toBe('Updated title');
    expect(retrieved?.riskLevel).toBe('MEDIUM');
    expect(retrieved?.reviewerCommentsCount).toBe(5);
  });

  it('能按项目列出 MR 状态', () => {
    const s1: MrReviewState = {
      id: 'mr-p1-1', projectId: '/tmp/proj-p1', mrIid: 1,
      sourceBranch: 'f1', targetBranch: 'main', state: 'opened',
      reviewerCommentsCount: 0, unresolvedCommentsCount: 0,
      createdAt: 1, updatedAt: 3,
    };
    const s2: MrReviewState = {
      id: 'mr-p1-2', projectId: '/tmp/proj-p1', mrIid: 2,
      sourceBranch: 'f2', targetBranch: 'main', state: 'opened',
      reviewerCommentsCount: 0, unresolvedCommentsCount: 0,
      createdAt: 2, updatedAt: 2,
    };
    const s3: MrReviewState = {
      id: 'mr-p2-1', projectId: '/tmp/proj-p2', mrIid: 1,
      sourceBranch: 'f3', targetBranch: 'main', state: 'opened',
      reviewerCommentsCount: 0, unresolvedCommentsCount: 0,
      createdAt: 3, updatedAt: 1,
    };

    store.insertOrUpdateMrState(s1);
    store.insertOrUpdateMrState(s2);
    store.insertOrUpdateMrState(s3);

    const p1States = store.listMrStatesByProject('/tmp/proj-p1');
    expect(p1States).toHaveLength(2);
    // 按 updated_at DESC 排序，s1 的 updatedAt=3 应该排在前面
    expect(p1States[0].mrIid).toBe(1);
    expect(p1States[1].mrIid).toBe(2);

    const p2States = store.listMrStatesByProject('/tmp/proj-p2');
    expect(p2States).toHaveLength(1);
    expect(p2States[0].mrIid).toBe(1);
  });

  it('能按状态列出 MR 状态', () => {
    const s1: MrReviewState = {
      id: 'mr-st-1', projectId: '/tmp/proj-st', mrIid: 1,
      sourceBranch: 'f1', targetBranch: 'main', state: 'opened',
      reviewerCommentsCount: 0, unresolvedCommentsCount: 0,
      createdAt: 1, updatedAt: 1,
    };
    const s2: MrReviewState = {
      id: 'mr-st-2', projectId: '/tmp/proj-st', mrIid: 2,
      sourceBranch: 'f2', targetBranch: 'main', state: 'merged',
      reviewerCommentsCount: 0, unresolvedCommentsCount: 0,
      createdAt: 2, updatedAt: 2,
    };
    const s3: MrReviewState = {
      id: 'mr-st-3', projectId: '/tmp/proj-st', mrIid: 3,
      sourceBranch: 'f3', targetBranch: 'main', state: 'opened',
      reviewerCommentsCount: 0, unresolvedCommentsCount: 0,
      createdAt: 3, updatedAt: 3,
    };

    store.insertOrUpdateMrState(s1);
    store.insertOrUpdateMrState(s2);
    store.insertOrUpdateMrState(s3);

    const opened = store.listMrStatesByState('opened');
    expect(opened).toHaveLength(2);

    const merged = store.listMrStatesByState('merged');
    expect(merged).toHaveLength(1);
    expect(merged[0].mrIid).toBe(2);
  });

  it('能部分更新 MR 状态', () => {
    const state: MrReviewState = {
      id: 'mr-patch',
      projectId: '/tmp/proj-patch',
      mrIid: 99,
      sourceBranch: 'feature/patch',
      targetBranch: 'main',
      state: 'opened',
      title: 'Before',
      riskLevel: 'LOW',
      reviewerCommentsCount: 0,
      unresolvedCommentsCount: 0,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    };

    store.insertOrUpdateMrState(state);

    store.updateMrState('/tmp/proj-patch', 99, {
      state: 'closed',
      title: 'After',
      riskLevel: 'HIGH',
      reviewerCommentsCount: 2,
      unresolvedCommentsCount: 1,
      ciStatus: 'failed',
    });

    const retrieved = store.getMrState('/tmp/proj-patch', 99);
    expect(retrieved?.state).toBe('closed');
    expect(retrieved?.title).toBe('After');
    expect(retrieved?.riskLevel).toBe('HIGH');
    expect(retrieved?.reviewerCommentsCount).toBe(2);
    expect(retrieved?.unresolvedCommentsCount).toBe(1);
    expect(retrieved?.ciStatus).toBe('failed');
    // 源分支不应被修改
    expect(retrieved?.sourceBranch).toBe('feature/patch');
  });

  it('注销项目会级联删除 MR 状态', () => {
    store.registerProject({ id: '/tmp/proj-del', rootPath: '/tmp/proj-del', name: 'proj-del', registeredAt: 1, lastScannedAt: null });

    const state: MrReviewState = {
      id: 'mr-del', projectId: '/tmp/proj-del', mrIid: 1,
      sourceBranch: 'f1', targetBranch: 'main', state: 'opened',
      reviewerCommentsCount: 0, unresolvedCommentsCount: 0,
      createdAt: 1, updatedAt: 1,
    };
    store.insertOrUpdateMrState(state);
    expect(store.listMrStatesByProject('/tmp/proj-del')).toHaveLength(1);

    store.unregisterProject('/tmp/proj-del');
    expect(store.listMrStatesByProject('/tmp/proj-del')).toHaveLength(0);
  });
});
