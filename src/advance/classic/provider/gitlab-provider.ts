/**
 * GitLab 平台 IGitProvider 实现
 *
 * 内部复用 src/gitlab/client.ts 的 GitLabClient，
 * 将 GitLab API 响应字段映射为 IGitProvider 统一格式。
 */

import {
  type IGitProvider,
  type MergeRequest,
  type MrDiff,
  type ReviewerComment,
  type MergeOptions,
} from './types.js';
import { GitLabClient } from '../../../gitlab/client.js';
import type { ProjectConfig } from '../../../types.js';
import type { GitlabConfig } from '../../types.js';

/**
 * 需要过滤的 bot / 系统账号用户名模式（词边界匹配）
 */
const BOT_PATTERN = /\b(bot|ci|codekeeper|gitlab|jenkins|github|renovate|dependabot)\b/i;

/**
 * 判断用户名是否为 bot
 *
 * 使用词边界匹配，避免 "abot"、"robert" 等正常用户名被误判。
 */
function isBot(username: string): boolean {
  return BOT_PATTERN.test(username);
}

/**
 * 从 diff 文本中统计新增 / 删除行数
 *
 * 规则：
 * - 以 '+' 开头且非 '+++' 文件头为新增
 * - 以 '-' 开头且非 '---' 文件头为删除
 * - 排除 diff 文件头行（--- a/...、+++ b/...）
 */
function countDiffLines(diffText: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }

  return { additions, deletions };
}

export class GitLabProvider implements IGitProvider {
  private client: GitLabClient;

  constructor(config: GitlabConfig) {
    // 构造最小化的 ProjectConfig 对象，满足 GitLabClient 构造要求
    // id / name / localPath 为占位值，gitlab 配置使用真实值
    const projectConfig: ProjectConfig = {
      id: 'placeholder',
      name: 'placeholder',
      localPath: '/tmp/placeholder',
      git: {
        remote: '',
        defaultBranch: 'main',
      },
      gitlab: {
        baseUrl: config.baseUrl,
        projectPath: config.projectPath,
        token: config.token,
      },
      review: {
        enabled: false,
        schedule: '',
        timezone: '',
        tokenBudget: 0,
        autoFix: false,
        autoFixBranchPrefix: '',
        rulesFile: '',
        astGrepConfig: '',
        filter: {
          excludeAuthors: [],
          excludeDrafts: false,
          minChanges: 0,
          maxChanges: 0,
          excludePaths: [],
        },
      },
      learning: {
        enabled: false,
        schedule: '',
        patternThreshold: 3,
        updateClaudeMd: false,
        createAstGrepRules: false,
        lookbackDays: 30,
      },
    };

    this.client = new GitLabClient(projectConfig);
  }

  /**
   * 列出所有开放的 MR
   */
  async listOpenMRs(): Promise<MergeRequest[]> {
    const gitlabMRs = await this.client.listMergeRequests({ state: 'opened' });

    return gitlabMRs.map((mr) => ({
      iid: mr.iid,
      title: mr.title,
      description: mr.description ?? '',
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      author: mr.author.username,
      draft: mr.draft,
      changesCount: Number(mr.changes_count) || 0,
      createdAt: mr.created_at,
      updatedAt: mr.updated_at,
      webUrl: mr.web_url,
    }));
  }

  /**
   * 获取指定 MR 的 diff 列表
   */
  async getMRDiff(iid: number): Promise<MrDiff[]> {
    const changes = await this.client.getMergeRequestChanges(iid);

    return changes.changes.map((change) => {
      const { additions, deletions } = countDiffLines(change.diff);

      return {
        filePath: change.new_path,
        oldPath: change.old_path,
        newPath: change.new_path,
        newFile: change.new_file,
        deletedFile: change.deleted_file,
        diff: change.diff,
        additions,
        deletions,
      };
    });
  }

  /**
   * 在指定 MR 下发布评论
   */
  async postReviewComment(iid: number, body: string): Promise<void> {
    await this.client.createNote(iid, body);
  }

  /**
   * 获取指定 MR 的评审评论
   *
   * 过滤掉：
   * 1. system notes（系统生成的 note）
   * 2. bot 用户发布的评论
   */
  async getReviewerComments(iid: number): Promise<ReviewerComment[]> {
    const notes = await this.client.getMergeRequestNotes(iid);

    return notes
      .filter((note) => !note.system && !isBot(note.author.username))
      .map((note) => ({
        author: note.author.username,
        body: note.body,
        createdAt: note.created_at,
        resolved: note.resolved ?? false,
      }));
  }

  /**
   * 获取指定 MR 的 CI 状态
   *
   * 通过获取 MR 详情中的 pipeline 状态推断。
   * GitLab MR API 返回的 head_pipeline 状态字段映射到统一状态。
   */
  async getCIStatus(
    iid: number
  ): Promise<'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'unknown'> {
    const mr = await this.client.getMergeRequest(iid);

    // GitLab MR 对象中 head_pipeline 的 status 字段
    const status = mr.head_pipeline?.status ?? 'unknown';

    switch (status) {
      case 'pending':
      case 'created':
        return 'pending';
      case 'running':
        return 'running';
      case 'success':
        return 'success';
      case 'failed':
      case 'canceled':
        return 'failed';
      case 'skipped':
        return 'skipped';
      default:
        return 'unknown';
    }
  }

  /**
   * 合并指定 MR
   *
   * TODO: GitLabClient 当前缺少 merge 方法，待后续补充。
   * 暂时抛出 NotImplementedError，避免调用方误以为成功。
   */
  async mergeMR(iid: number, options?: MergeOptions): Promise<void> {
    throw new Error(
      `[GitLabProvider] mergeMR 尚未实现 (iid=${iid}, options=${JSON.stringify(options)})`
    );
  }
}
