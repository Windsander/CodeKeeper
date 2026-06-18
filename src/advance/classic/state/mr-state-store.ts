/**
 * MR 状态存储封装
 * 基于 MetadataStore 提供类型安全的 MR 状态操作接口
 */
import type { MrReviewState } from '../../types';
import type { MetadataStore } from '../../store/metadata-store';

/**
 * 允许局部更新的字段类型（排除不可变字段）
 */
export type MrStatePatch = Partial<
  Omit<MrReviewState, 'id' | 'projectId' | 'mrIid' | 'createdAt'>
>;

/**
 * MR 状态存储封装类
 * 将底层 MetadataStore 的原始操作包装为类型安全的 API
 */
export class MrStateStore {
  constructor(private readonly store: MetadataStore) {}

  /**
   * 保存或更新 MR 状态记录
   * 若 projectId + mrIid 已存在则执行更新，否则插入新记录
   */
  save(state: MrReviewState): void {
    this.store.insertOrUpdateMrState(state);
  }

  /**
   * 根据项目 ID 和 MR IID 获取单条状态记录
   * @returns 状态记录或 undefined（未找到时）
   */
  get(projectId: string, mrIid: number): MrReviewState | undefined {
    return this.store.getMrState(projectId, mrIid);
  }

  /**
   * 列出指定项目下的所有 MR 状态记录
   * 按 updatedAt 降序排列
   */
  listByProject(projectId: string): MrReviewState[] {
    return this.store.listMrStatesByProject(projectId).filter((s): s is MrReviewState => s !== undefined);
  }

  /**
   * 列出处于指定状态的所有 MR 状态记录
   * 按 updatedAt 降序排列
   */
  listByState(state: string): MrReviewState[] {
    return this.store.listMrStatesByState(state).filter((s): s is MrReviewState => s !== undefined);
  }

  /**
   * 局部更新指定 MR 状态记录
   * 仅更新 patch 中提供的字段，其余字段保持不变
   */
  update(projectId: string, mrIid: number, patch: MrStatePatch): void {
    this.store.updateMrState(projectId, mrIid, patch);
  }
}
