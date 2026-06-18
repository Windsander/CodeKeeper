/**
 * MR 状态枚举
 * 定义 MR 在生命周期中可能处于的所有状态
 */
export type MrState =
  | 'detected'
  | 'reviewing'
  | 'fixing'
  | 'awaiting-review'
  | 'merging'
  | 'done'
  | 'failed';

/**
 * 状态流转规则表
 * 记录每个状态允许流转到的目标状态列表
 */
const ALLOWED_TRANSITIONS: Record<MrState, MrState[]> = {
  detected: ['reviewing', 'failed'],
  reviewing: ['fixing', 'awaiting-review', 'done', 'failed'],
  fixing: ['awaiting-review', 'failed'],
  'awaiting-review': ['fixing', 'merging', 'done', 'failed'],
  merging: ['done', 'failed'],
  done: [],
  failed: ['detected'],
};

/**
 * 判断从 `from` 状态到 `to` 状态的流转是否合法
 * @param from 当前状态
 * @param to 目标状态
 * @returns 是否允许流转
 */
export function canTransition(from: MrState, to: MrState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
