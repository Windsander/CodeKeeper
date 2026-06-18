/**
 * MR 状态机与状态存储测试
 */
import { describe, it, expect, vi } from 'vitest';
import { canTransition, type MrState } from '../../../../src/advance/classic/state/mr-state-machine';
import { MrStateStore, type MrStatePatch } from '../../../../src/advance/classic/state/mr-state-store';
import type { MrReviewState } from '../../../../src/advance/types';

describe('canTransition', () => {
  /**
   * 辅助函数：生成所有状态对的测试用例
   */
  function testTransition(from: MrState, to: MrState, expected: boolean): void {
    it(`\`${from}\` → \`${to}\` 应该${expected ? '允许' : '拒绝'}`, () => {
      expect(canTransition(from, to)).toBe(expected);
    });
  }

  describe('合法流转路径', () => {
    // detected 允许流转
    testTransition('detected', 'reviewing', true);
    testTransition('detected', 'failed', true);

    // reviewing 允许流转
    testTransition('reviewing', 'fixing', true);
    testTransition('reviewing', 'awaiting-review', true);
    testTransition('reviewing', 'done', true);
    testTransition('reviewing', 'failed', true);

    // fixing 允许流转
    testTransition('fixing', 'awaiting-review', true);
    testTransition('fixing', 'failed', true);

    // awaiting-review 允许流转
    testTransition('awaiting-review', 'fixing', true);
    testTransition('awaiting-review', 'merging', true);
    testTransition('awaiting-review', 'done', true);
    testTransition('awaiting-review', 'failed', true);

    // merging 允许流转
    testTransition('merging', 'done', true);
    testTransition('merging', 'failed', true);

    // failed 允许流转（重新检测）
    testTransition('failed', 'detected', true);
  });

  describe('非法流转路径', () => {
    // detected 不允许的流转
    testTransition('detected', 'detected', false);
    testTransition('detected', 'fixing', false);
    testTransition('detected', 'awaiting-review', false);
    testTransition('detected', 'merging', false);
    testTransition('detected', 'done', false);

    // reviewing 不允许的流转
    testTransition('reviewing', 'detected', false);
    testTransition('reviewing', 'reviewing', false);
    testTransition('reviewing', 'merging', false);

    // fixing 不允许的流转
    testTransition('fixing', 'detected', false);
    testTransition('fixing', 'reviewing', false);
    testTransition('fixing', 'fixing', false);
    testTransition('fixing', 'merging', false);
    testTransition('fixing', 'done', false);

    // awaiting-review 不允许的流转
    testTransition('awaiting-review', 'detected', false);
    testTransition('awaiting-review', 'reviewing', false);
    testTransition('awaiting-review', 'awaiting-review', false);

    // merging 不允许的流转
    testTransition('merging', 'detected', false);
    testTransition('merging', 'reviewing', false);
    testTransition('merging', 'fixing', false);
    testTransition('merging', 'awaiting-review', false);
    testTransition('merging', 'merging', false);

    // done 为终态，不允许任何流转
    testTransition('done', 'detected', false);
    testTransition('done', 'reviewing', false);
    testTransition('done', 'fixing', false);
    testTransition('done', 'awaiting-review', false);
    testTransition('done', 'merging', false);
    testTransition('done', 'done', false);
    testTransition('done', 'failed', false);

    // failed 不允许除 detected 外的流转
    testTransition('failed', 'reviewing', false);
    testTransition('failed', 'fixing', false);
    testTransition('failed', 'awaiting-review', false);
    testTransition('failed', 'merging', false);
    testTransition('failed', 'done', false);
    testTransition('failed', 'failed', false);
  });
});

describe('MrStateStore', () => {
  /**
   * 创建 Mock MetadataStore
   * 使用 vi.fn() 模拟所有 MR 状态相关方法
   */
  function createMockStore() {
    return {
      insertOrUpdateMrState: vi.fn(),
      getMrState: vi.fn(),
      listMrStatesByProject: vi.fn().mockReturnValue([]),
      listMrStatesByState: vi.fn().mockReturnValue([]),
      updateMrState: vi.fn(),
    } as unknown as Parameters<typeof MrStateStore>[0];
  }

  /**
   * 创建示例 MR 状态记录
   */
  function createSampleState(overrides?: Partial<MrReviewState>): MrReviewState {
    return {
      id: 'test-id',
      projectId: 'proj-1',
      mrIid: 42,
      sourceBranch: 'feature/test',
      targetBranch: 'main',
      state: 'detected',
      title: 'Test MR',
      webUrl: 'https://git.example.com/mr/42',
      findingsJson: undefined,
      fixBranch: undefined,
      riskLevel: 'LOW',
      reviewerCommentsCount: 0,
      unresolvedCommentsCount: 0,
      ciStatus: 'success',
      lastReviewerCommentAt: undefined,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      ...overrides,
    };
  }

  it('save() 应调用 insertOrUpdateMrState', () => {
    const mockStore = createMockStore();
    const store = new MrStateStore(mockStore);
    const state = createSampleState();

    store.save(state);

    expect(mockStore.insertOrUpdateMrState).toHaveBeenCalledTimes(1);
    expect(mockStore.insertOrUpdateMrState).toHaveBeenCalledWith(state);
  });

  it('get() 应调用 getMrState 并返回结果', () => {
    const mockStore = createMockStore();
    const store = new MrStateStore(mockStore);
    const expected = createSampleState();
    mockStore.getMrState.mockReturnValue(expected);

    const result = store.get('proj-1', 42);

    expect(mockStore.getMrState).toHaveBeenCalledTimes(1);
    expect(mockStore.getMrState).toHaveBeenCalledWith('proj-1', 42);
    expect(result).toBe(expected);
  });

  it('get() 未找到时应返回 undefined', () => {
    const mockStore = createMockStore();
    const store = new MrStateStore(mockStore);
    mockStore.getMrState.mockReturnValue(undefined);

    const result = store.get('proj-1', 999);

    expect(result).toBeUndefined();
  });

  it('listByProject() 应调用 listMrStatesByProject', () => {
    const mockStore = createMockStore();
    const store = new MrStateStore(mockStore);
    const expected = [createSampleState(), createSampleState({ mrIid: 43 })];
    mockStore.listMrStatesByProject.mockReturnValue(expected);

    const result = store.listByProject('proj-1');

    expect(mockStore.listMrStatesByProject).toHaveBeenCalledTimes(1);
    expect(mockStore.listMrStatesByProject).toHaveBeenCalledWith('proj-1');
    expect(result).toEqual(expected);
  });

  it('listByState() 应调用 listMrStatesByState', () => {
    const mockStore = createMockStore();
    const store = new MrStateStore(mockStore);
    const expected = [createSampleState({ state: 'reviewing' })];
    mockStore.listMrStatesByState.mockReturnValue(expected);

    const result = store.listByState('reviewing');

    expect(mockStore.listMrStatesByState).toHaveBeenCalledTimes(1);
    expect(mockStore.listMrStatesByState).toHaveBeenCalledWith('reviewing');
    expect(result).toEqual(expected);
  });

  it('update() 应调用 updateMrState 并传递 patch', () => {
    const mockStore = createMockStore();
    const store = new MrStateStore(mockStore);
    const patch: MrStatePatch = { state: 'reviewing', riskLevel: 'MEDIUM' };

    store.update('proj-1', 42, patch);

    expect(mockStore.updateMrState).toHaveBeenCalledTimes(1);
    expect(mockStore.updateMrState).toHaveBeenCalledWith('proj-1', 42, patch);
  });
});
