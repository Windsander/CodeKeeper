import type { GitLabProvider } from '../provider/gitlab-provider.js';
import type { MergeRequest, ReviewResult } from '../provider/types.js';
import { formatReviewComment } from '../runners/shared/review-utils.js';

export interface ReviewerActorOptions {
  /** GitLab API 提供者 */
  provider: GitLabProvider;
}

/**
 * ReviewerActor
 *
 * 负责把 ReviewerBrain 的评审结果发布到 GitLab MR 上。
 */
export class ReviewerActor {
  constructor(private readonly options: ReviewerActorOptions) {}

  /**
   * 发表评审 summary 评论
   */
  async postReview(mr: MergeRequest, result: ReviewResult): Promise<void> {
    const comment = formatReviewComment(mr, result);
    try {
      await this.options.provider.postReviewComment(mr.iid, comment);
      console.log(`[ReviewerActor] 已在 MR !${mr.iid} 发表 summary 评论`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ReviewerActor] 在 MR !${mr.iid} 发表 summary 评论失败: ${message}`);
    }
  }
}
