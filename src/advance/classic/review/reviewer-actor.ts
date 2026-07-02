import type { GitLabProvider } from '../provider/gitlab-provider.js';
import { buildDiffPosition, getFindingKey } from '../provider/discussion-mapper.js';
import type { MergeRequest, MrDiff, MrShaInfo, ReviewResult } from '../provider/types.js';
import { saveState, type MrAgentState } from '../runners/shared/state-utils.js';
import type { Project } from '../../types.js';
import { formatFindingThreadComment, formatReviewComment } from '../runners/shared/review-utils.js';

export interface ReviewerActorOptions {
  /** GitLab API 提供者 */
  provider: GitLabProvider;
  /** 当前项目，用于持久化 discussion 状态 */
  project?: Project;
}

export interface PostReviewOptions {
  diffs?: MrDiff[];
  shaInfo?: MrShaInfo;
  stateKey?: string;
  state?: MrAgentState;
}

/**
 * ReviewerActor
 *
 * 负责把 ReviewerBrain 的评审结果发布到 GitLab MR 上，
 * 并为严重 finding 创建代码行级 discussion threads。
 */
export class ReviewerActor {
  constructor(private readonly options: ReviewerActorOptions) {}

  /**
   * 发表评审 summary 评论，并按配置创建严重 finding 的 discussion threads
   */
  async postReview(mr: MergeRequest, result: ReviewResult, options?: PostReviewOptions): Promise<void> {
    const comment = formatReviewComment(mr, result);
    try {
      await this.options.provider.postReviewComment(mr.iid, comment);
      console.log(`[ReviewerActor] 已在 MR !${mr.iid} 发表 summary 评论`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ReviewerActor] 在 MR !${mr.iid} 发表 summary 评论失败: ${message}`);
      throw error;
    }

    await this.createFindingThreads(mr, result, options);
  }

  private async createFindingThreads(
    mr: MergeRequest,
    result: ReviewResult,
    options?: PostReviewOptions
  ): Promise<void> {
    if (!options?.diffs || !options.shaInfo || !options.stateKey || !options.state || !this.options.project) {
      console.log('[ReviewerActor] 缺少创建 discussion threads 的必要上下文，跳过');
      return;
    }

    const { diffs, shaInfo, stateKey, state } = options;
    const posted = state.discussions[stateKey] ?? [];
    const severities = new Set<ReviewResult['findings'][number]['severity']>(['CRITICAL', 'HIGH']);
    const candidates = result.findings.filter((f) => severities.has(f.severity));

    console.log(`[ReviewerActor] MR !${mr.iid} 存在 ${candidates.length} 个 CRITICAL/HIGH finding，已发布 ${posted.length} 个`);

    for (const finding of result.findings) {
      if (!severities.has(finding.severity)) continue;
      const key = getFindingKey(finding);
      if (posted.some((p) => p.findingKey === key)) continue;

      const position = buildDiffPosition(finding, diffs, shaInfo);
      if (!position) {
        console.warn(`[ReviewerActor] 无法为 finding ${finding.file}:${finding.line} 构造 diff position`);
        continue;
      }

      const body = formatFindingThreadComment(finding);
      try {
        const discussionId = await this.options.provider.createDiscussion(mr.iid, body, position);
        posted.push({
          findingKey: key,
          discussionId,
          file: finding.file,
          line: finding.line,
          severity: finding.severity,
          resolved: false,
        });
        console.log(`[ReviewerActor] 已为 finding ${finding.file}:${finding.line} 创建 discussion ${discussionId}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ReviewerActor] 创建 finding thread 失败 ${finding.file}:${finding.line}: ${message}`);
      }
    }

    state.discussions[stateKey] = posted;
    saveState(this.options.project, state);
  }
}
