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
  type Discussion,
  type ReviewerComment,
  type RemoteActivitySnapshot,
  type ReviewerCommentSnapshot,
  type MergeOptions,
  type GitLabDiffPosition,
  type MrOverview,
  type CiFailureReport,
  type CiFailedJob,
} from './types.js';
import {
  selectRecentActiveComments,
  selectRecentActiveDiscussions,
} from './activity-window.js';
import { matchesFilter } from './mr-filter.js';
import { GitLabClient } from '../../../gitlab/client.js';
import type { ProjectConfig } from '../../../types.js';
import type { GitlabConfig, MrReviewFilter } from '../../types.js';

/**
 * 需要过滤的 bot / 系统账号用户名模式（词边界匹配）
 */
const BOT_PATTERN =
  /(?:^|[_\-[\]])(?:bot|ci|codekeeper|gitlab|jenkins|github|renovate|dependabot)(?:[_\-[\]]|$)|_bot_[a-f0-9]{8,}$/i;
const AGENT_COMMENT_MARKER = 'CodeKeeper Advance';

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

  async listMembers(): Promise<Array<{ username: string; name?: string }>> {
    const members = await this.client.listMembers();
    return members.map((m) => ({ username: m.username, name: m.name }));
  }

  async listLabels(): Promise<string[]> {
    const labels = await this.client.listLabels();
    return labels.map((l) => l.name);
  }

  async listProtectedBranches(): Promise<string[]> {
    const branches = await this.client.listProtectedBranches();
    return branches.map((b) => b.name);
  }

  async listBranches(): Promise<string[]> {
    const branches = await this.client.listBranches();
    return branches.map((b) => b.name);
  }

  async verify(): Promise<void> {
    await this.client.verifyProject();
  }

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
   * 列出所有开放的 MR，支持按过滤条件筛选
   */
  async listOpenMRs(filters?: MrReviewFilter): Promise<MergeRequest[]> {
    const apiParams: Record<string, string> = {
      state: 'opened',
      per_page: '50',
      order_by: 'updated_at',
      sort: 'desc',
    };

    // 取每个字段的第一个值利用 GitLab API 预过滤，减少传输量
    if (filters) {
      for (const condition of filters.conditions) {
        const values = condition.values.filter((v) => v.trim() !== '');
        if (values.length === 0) continue;
        const firstValue = values[0];
        switch (condition.field) {
          case 'author':
            apiParams.author_username = firstValue;
            break;
          case 'assignee':
            apiParams.assignee_username = firstValue;
            break;
          case 'reviewer':
            apiParams.reviewer_username = firstValue;
            break;
          case 'label':
            apiParams.labels = firstValue;
            break;
          case 'sourceBranch':
            apiParams.source_branch = firstValue;
            break;
          case 'targetBranch':
            apiParams.target_branch = firstValue;
            break;
        }
      }
    }

    const gitlabMRs = await this.client.listMergeRequests({
      state: apiParams.state,
      per_page: Number(apiParams.per_page),
      order_by: apiParams.order_by,
      sort: apiParams.sort,
      author_username: apiParams.author_username,
      assignee_username: apiParams.assignee_username,
      reviewer_username: apiParams.reviewer_username,
      labels: apiParams.labels,
      source_branch: apiParams.source_branch,
      target_branch: apiParams.target_branch,
    });

    const mrs = gitlabMRs.map((mr) => ({
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
      assignee: (mr as unknown as { assignee?: { username: string } }).assignee?.username,
      reviewers: (mr as unknown as { reviewers?: Array<{ username: string }> }).reviewers?.map((r) => r.username),
      labels: (mr as unknown as { labels?: string[] }).labels,
    }));

    return mrs.filter((mr) => matchesFilter(mr, filters));
  }

  /**
   * 获取指定 MR 的 SHA 信息（base / head / start）
   */
  async getMRShaInfo(iid: number): Promise<{ baseSha: string; headSha: string; startSha: string }> {
    const mr = await this.client.getMergeRequest(iid);
    const refs = (mr as unknown as { diff_refs?: { base_sha: string; head_sha: string; start_sha: string } }).diff_refs;
    if (!refs) {
      throw new Error(`[GitLabProvider] MR !${iid} 未返回 diff_refs`);
    }
    return {
      baseSha: refs.base_sha,
      headSha: refs.head_sha,
      startSha: refs.start_sha,
    };
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
   * 在指定 MR 下创建 discussion thread
   *
   * 返回新创建 discussion 的 id。
   */
  async createDiscussion(
    iid: number,
    body: string,
    position?: GitLabDiffPosition
  ): Promise<string> {
    const gitlabPosition = position
      ? {
          base_sha: position.baseSha,
          head_sha: position.headSha,
          start_sha: position.startSha,
          position_type: position.positionType,
          old_path: position.oldPath,
          new_path: position.newPath,
          new_line: position.newLine,
          old_line: position.oldLine,
        }
      : undefined;
    const discussion = await this.client.createDiscussion(iid, body, gitlabPosition);
    return discussion.id;
  }

  /** 获取指定 MR 最近活跃的 discussions。 */
  async getDiscussions(iid: number): Promise<Discussion[]> {
    return (await this.getDiscussionSnapshot(iid)).active;
  }

  /** 获取全量 discussion 事实，并单独生成最近活动窗口。 */
  async getDiscussionSnapshot(iid: number): Promise<RemoteActivitySnapshot<Discussion>> {
    const discussions = await this.client.getMergeRequestDiscussions(iid);
    const all = discussions
      .map((discussion) => {
        const notes = discussion.notes.filter(note => !note.system);
        const position = discussion.position ?? discussion.notes.find((note) => note.position)?.position;
        return {
          id: discussion.id,
          // 某些 GitLab 实例/版本对普通 note discussion 不返回 resolvable/resolved，默认视为可处理
          resolvable: discussion.resolvable ?? true,
          resolved: discussion.resolved ?? false,
          notes: notes.map((note) => ({
            id: note.id,
            author: note.author.username,
            body: note.body,
            createdAt: note.created_at,
            updatedAt: note.updated_at,
            resolved: note.resolved ?? false,
          })),
          position: position
            ? {
                newPath: position.new_path,
                newLine: position.new_line,
                oldPath: position.old_path,
                oldLine: position.old_line,
                headSha: position.head_sha,
              }
            : undefined,
        };
      })
      .filter(discussion => discussion.notes.length > 0);

    return {
      all,
      active: selectRecentActiveDiscussions(all),
    };
  }

  /**
   * Resolve 或 unresolve 指定 discussion
   */
  async resolveDiscussion(iid: number, discussionId: string, resolved = true): Promise<void> {
    await this.client.resolveDiscussion(iid, discussionId, resolved);
  }

  /**
   * 在指定 discussion 下追加 note
   */
  async addDiscussionNote(iid: number, discussionId: string, body: string): Promise<number> {
    const note = await this.client.addDiscussionNote(iid, discussionId, body);
    return note.id;
  }

  /**
   * 在指定 MR 下发布评论
   */
  async postReviewComment(iid: number, body: string): Promise<number> {
    const note = await this.client.createNote(iid, body);
    return note.id;
  }

  /** 获取指定 MR 最近活跃的人工评审评论。 */
  async getReviewerComments(iid: number): Promise<ReviewerComment[]> {
    return (await this.getReviewerCommentSnapshot(iid)).activeHuman;
  }

  /** 获取全量非系统评论，并分别生成全体与人工评论活动窗口。 */
  async getReviewerCommentSnapshot(iid: number): Promise<ReviewerCommentSnapshot> {
    const notes = await this.client.getMergeRequestNotes(iid);
    const all = notes
      .filter((note) => !note.system)
      .map((note) => ({
        id: note.id,
        author: note.author.username,
        body: note.body,
        createdAt: note.created_at,
        updatedAt: note.updated_at,
        resolved: note.resolved ?? false,
      }));

    const active = selectRecentActiveComments(all);
    return {
      all,
      active,
      activeHuman: active.filter(
        comment => !isBot(comment.author) && !comment.body.includes(AGENT_COMMENT_MARKER)
      ),
    };
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

  /**
   * 获取指定 MR 的概览信息（生命周期终态感知）
   */
  async getMROverview(iid: number): Promise<MrOverview> {
    const mr = await this.client.getMergeRequest(iid);
    const refs = (mr as unknown as { diff_refs?: { head_sha?: string } }).diff_refs;
    const labels = (mr as unknown as { labels?: string[] }).labels;
    return {
      state: mr.state ?? 'unknown',
      headSha: refs?.head_sha,
      labels: labels ?? [],
    };
  }

  /**
   * 获取指定 MR 的 CI 失败报告
   *
   * 以 MR 最新 pipeline 为准；仅当状态为 failed 时收集失败 job 的日志尾部，
   * 供 Maintainer 做最小化 CI 修复。单个 job 日志只保留尾部片段，避免超大 trace
   * 占用内存；收集 job 数量上限同样受控。
   */
  async getCiFailureReport(iid: number): Promise<CiFailureReport> {
    const status = await this.getCIStatus(iid);
    if (status !== 'failed') {
      return { status, failedJobs: [] };
    }

    const pipelines = await this.client.getMergeRequestPipelines(iid, 1);
    const pipeline = pipelines[0];
    if (!pipeline) {
      return { status, failedJobs: [] };
    }

    const jobs = await this.client.listPipelineJobs(pipeline.id);
    const failed = jobs.filter(job => job.status === 'failed').slice(0, MAX_CI_FAILURE_JOBS);

    const failedJobs: CiFailedJob[] = [];
    for (const job of failed) {
      let traceTail = '';
      try {
        const trace = await this.client.getJobTrace(job.id);
        traceTail = trace.slice(-CI_TRACE_TAIL_CHARS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        traceTail = `(获取 job 日志失败: ${message})`;
      }
      failedJobs.push({
        id: job.id,
        name: job.name,
        stage: job.stage,
        failureReason: job.failure_reason,
        traceTail,
        webUrl: job.web_url,
      });
    }

    return {
      status,
      pipelineId: pipeline.id,
      pipelineSha: pipeline.sha,
      pipelineWebUrl: pipeline.web_url,
      failedJobs,
    };
  }
}

/** CI 失败诊断最多收集的 job 数 */
const MAX_CI_FAILURE_JOBS = 3;
/** 单个失败 job 保留的日志尾部字符数 */
const CI_TRACE_TAIL_CHARS = 4000;
