/**
 * 配置相关工具函数
 *
 * 供 ReviewerRunner 和 MaintainerRunner 共享使用。
 */

import type { Project, GitlabConfig, MrReviewConfig } from '../../../types.js';

/**
 * 根据 GitLab 配置构造远程仓库 HTTPS URL（不含认证信息）
 */
export function buildRemoteUrl(gitlab: GitlabConfig): string {
  const base = gitlab.baseUrl.replace(/\/$/, '');
  const path = gitlab.projectPath.replace(/^\//, '');
  return `${base}/${path}.git`;
}

/**
 * 根据 GitLab 配置构造带 Access Token 的远程仓库 HTTPS URL
 * 用于 worktree clone/push，避免弹出用户名密码对话框
 */
export function buildAuthenticatedRemoteUrl(gitlab: GitlabConfig): string {
  const base = gitlab.baseUrl.replace(/\/$/, '');
  const path = gitlab.projectPath.replace(/^\//, '');
  const url = new URL(`${base}/${path}.git`);
  url.username = 'oauth2';
  url.password = gitlab.token;
  return url.toString();
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
