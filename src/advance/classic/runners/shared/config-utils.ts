/**
 * 配置相关工具函数
 *
 * 供 ReviewerRunner 和 MaintainerRunner 共享使用。
 */

import type { Project, GitlabConfig, MrReviewConfig } from '../../../types.js';

/**
 * 根据 GitLab 配置构造远程仓库 HTTPS URL
 */
export function buildRemoteUrl(gitlab: GitlabConfig): string {
  const base = gitlab.baseUrl.replace(/\/$/, '');
  const path = gitlab.projectPath.replace(/^\//, '');
  return `${base}/${path}.git`;
}

/**
 * 获取项目的 MR 评审配置（兼容旧 mrReview 字段）
 */
export function getMrReviewConfig(project: Project): MrReviewConfig {
  return (
    project.mrReview ?? {
      enabled: true,
      agentRole: 'reviewer+auto-fixer',
      autoMergeMode: 'audit',
      reviewSchedule: '*/10 * * * *',
      learningEnabled: false,
      maxAutoMergeRisk: 'MEDIUM',
      autoFixEnabled: true,
      resolveOthersDiscussions: true,
    }
  );
}
