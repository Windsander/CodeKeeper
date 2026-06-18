import type { ReviewFinding, MrDiff, GitLabDiffPosition } from './types.js';

export interface MrShaInfo {
  baseSha: string;
  headSha: string;
  startSha: string;
}

/**
 * 根据 finding 和 diff 列表构造 GitLab discussion 定位信息
 *
 * 定位规则：
 * - 用 finding.file 匹配 diff.newPath（新增/重命名文件时）或 diff.oldPath（删除文件时）
 * - 默认使用 new_line 定位，deleted file 时使用 old_line
 * - 若找不到对应 diff 或行号非法，返回 null
 */
export function buildDiffPosition(
  finding: ReviewFinding,
  diffs: MrDiff[],
  shaInfo: MrShaInfo
): GitLabDiffPosition | null {
  const diff = diffs.find(
    (d) => d.newPath === finding.file ||
    (d.deletedFile && d.oldPath === finding.file)
  );
  if (!diff) {
    return null;
  }

  const newLine = Number(finding.line);
  if (!Number.isFinite(newLine) || newLine <= 0) {
    return null;
  }

  if (diff.deletedFile) {
    return {
      baseSha: shaInfo.baseSha,
      headSha: shaInfo.headSha,
      startSha: shaInfo.startSha,
      positionType: 'text',
      oldPath: diff.oldPath,
      newPath: diff.newPath,
      newLine: 0,
      oldLine: newLine,
    };
  }

  return {
    baseSha: shaInfo.baseSha,
    headSha: shaInfo.headSha,
    startSha: shaInfo.startSha,
    positionType: 'text',
    oldPath: diff.oldPath,
    newPath: diff.newPath,
    newLine,
  };
}

/**
 * 生成 finding 的唯一键，用于去重和映射持久化
 */
export function getFindingKey(finding: ReviewFinding): string {
  return `${finding.file}:${finding.line}:${finding.ruleId ?? 'generic'}`;
}
