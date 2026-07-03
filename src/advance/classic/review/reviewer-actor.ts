import type { GitLabProvider } from '../provider/gitlab-provider.js';
import { buildDiffPosition, getFindingKey } from '../provider/discussion-mapper.js';
import type { MergeRequest, MrDiff, MrShaInfo, ReviewFinding, ReviewResult } from '../provider/types.js';
import { saveState, type MrAgentState } from '../runners/shared/state-utils.js';
import type { Project } from '../../types.js';
import {
  formatFindingThreadComment,
  formatReviewComment,
  formatSupplementaryReviewComment,
} from '../runners/shared/review-utils.js';

export interface ReviewerActorOptions {
  /** GitLab API 提供者 */
  provider: GitLabProvider;
  /** 当前项目，用于持久化 discussion 状态 */
  project?: Project;
  /** Reviewer Agent 显示名称，用于评论签名 */
  reviewerName?: string;
  /** 需要创建 discussion thread 的严重等级 */
  threadRiskLevels?: ReviewFinding['severity'][];
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
  private readonly threadRiskLevels: ReviewFinding['severity'][];

  constructor(private readonly options: ReviewerActorOptions) {
    this.threadRiskLevels = options.threadRiskLevels ?? ['CRITICAL', 'HIGH'];
  }

  /**
   * 发表评审 summary 评论，并按配置创建严重 finding 的 discussion threads
   * 返回 summary 评论的 note ID
   */
  async postReview(mr: MergeRequest, result: ReviewResult, options?: PostReviewOptions): Promise<number> {
    const comment = formatReviewComment(mr, result, this.options.reviewerName);
    let noteId: number;
    try {
      noteId = await this.options.provider.postReviewComment(mr.iid, comment);
      console.log(`[ReviewerActor] 已在 MR !${mr.iid} 发表 summary 评论`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ReviewerActor] 在 MR !${mr.iid} 发表 summary 评论失败: ${message}`);
      throw error;
    }

    await this.createFindingThreads(mr, result.findings, options);
    return noteId;
  }

  /**
   * 追加补充评审评论（MR 有更新或发现新问题时）
   * 返回补充评论的 note ID
   */
  async appendSupplementaryReview(mr: MergeRequest, newFindings: ReviewFinding[]): Promise<number> {
    if (newFindings.length === 0) {
      throw new Error('无新增发现项时不应追加补充评审');
    }
    const body = formatSupplementaryReviewComment(mr, newFindings, this.options.reviewerName);
    try {
      const noteId = await this.options.provider.postReviewComment(mr.iid, body);
      console.log(`[ReviewerActor] 已在 MR !${mr.iid} 追加补充评审`);
      return noteId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ReviewerActor] 在 MR !${mr.iid} 追加补充评审失败: ${message}`);
      throw error;
    }
  }

  /**
   * 为 CRITICAL/HIGH finding 创建代码行级 discussion threads
   */
  async createFindingThreads(
    mr: MergeRequest,
    findings: ReviewFinding[],
    options?: PostReviewOptions
  ): Promise<void> {
    if (!options?.diffs || !options.shaInfo || !options.stateKey || !options.state || !this.options.project) {
      console.log('[ReviewerActor] 缺少创建 discussion threads 的必要上下文，跳过');
      return;
    }

    const { diffs, shaInfo, stateKey, state } = options;
    const posted = state.discussions[stateKey] ?? [];
    const severities = new Set<ReviewFinding['severity']>(this.threadRiskLevels);
    const candidates = findings.filter((f) => severities.has(f.severity));

    console.log(`[ReviewerActor] MR !${mr.iid} 存在 ${candidates.length} 个 CRITICAL/HIGH finding，已发布 ${posted.length} 个`);

    for (const finding of findings) {
      if (!severities.has(finding.severity)) continue;
      const key = getFindingKey(finding);
      if (posted.some((p) => p.findingKey === key)) continue;

      const position = buildDiffPosition(finding, diffs, shaInfo);
      if (!position) {
        console.warn(`[ReviewerActor] 无法为 finding ${finding.file}:${finding.line} 构造 diff position`);
        continue;
      }

      const body = formatFindingThreadComment(finding, this.options.reviewerName);
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
