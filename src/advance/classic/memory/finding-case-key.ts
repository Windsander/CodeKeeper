import { sanitizeEverOSId } from './types.js';

export interface FindingCaseKeyParts {
  /** 项目标识 */
  projectId: string;
  /** MR 内部编号 */
  mrIid: number;
  /** 文件路径 */
  file: string;
  /** 行号 */
  line: number;
  /** 规则 ID（可选） */
  ruleId?: string;
}

/**
 * 生成 finding case 的全局唯一 key，用于 EverOS 去重与召回。
 * 与 Reviewer 侧历史逻辑保持一致：case:<project>:mr-<iid>:<file>:<line>:<ruleId>
 */
export function buildFindingCaseKey(parts: FindingCaseKeyParts): string {
  const safeProject = sanitizeEverOSId(parts.projectId);
  const safeFile = sanitizeEverOSId(parts.file);
  const safeRule = sanitizeEverOSId(parts.ruleId ?? 'generic');
  return `case:${safeProject}:mr-${parts.mrIid}:${safeFile}:${parts.line}:${safeRule}`;
}
