import { GitLabClient, type GitLabMR } from './client.js';
import { logger } from '../core/logger.js';
import type { ProjectConfig, MergeRequest, MrDiff, ReviewFilter } from '../types.js';

export class MRService {
  private client: GitLabClient;

  constructor(private project: ProjectConfig) {
    this.client = new GitLabClient(project);
  }

  /**
   * Get open MRs that match filter criteria
   */
  async getReviewableMRs(): Promise<MergeRequest[]> {
    const filter = this.project.review.filter;
    logger.info(`[${this.project.id}] Fetching open MRs...`);

    const mrs = await this.client.listMergeRequests({
      state: 'opened',
      per_page: 50,
    });

    logger.info(`[${this.project.id}] Found ${mrs.length} open MRs`);

    const filtered = mrs
      .map(this.mapGitLabMR)
      .filter((mr) => this.shouldReview(mr, filter));

    logger.info(`[${this.project.id}] ${filtered.length} MRs pass filter`);
    return filtered;
  }

  /**
   * Get MR diff via GitLab API
   */
  async getMRDiff(iid: number): Promise<MrDiff[]> {
    logger.debug(`[${this.project.id}] Fetching MR ${iid} changes`);

    const changes = await this.client.getMergeRequestChanges(iid);

    return changes.changes.map((c) => ({
      filePath: c.new_path,
      oldPath: c.old_path,
      newPath: c.new_path,
      newFile: c.new_file,
      deletedFile: c.deleted_file,
      diff: c.diff,
      additions: this.countLines(c.diff, '+'),
      deletions: this.countLines(c.diff, '-'),
    }));
  }

  /**
   * Post review comment to MR
   */
  async postReviewComment(iid: number, comment: string): Promise<void> {
    logger.info(`[${this.project.id}] Posting review comment to MR !${iid}`);
    await this.client.createNote(iid, comment);
  }

  /**
   * Get reviewer comments on a merged MR (for learning loop)
   */
  async getReviewerComments(iid: number): Promise<Array<{ author: string; body: string; createdAt: string }>> {
    const notes = await this.client.getMergeRequestNotes(iid);
    const discussions = await this.client.getMergeRequestDiscussions(iid);

    const comments: Array<{ author: string; body: string; createdAt: string }> = [];

    // Filter out system notes and bot comments
    for (const note of notes) {
      if (note.system) continue;
      if (this.isBotAuthor(note.author.username)) continue;

      comments.push({
        author: note.author.username,
        body: note.body,
        createdAt: note.created_at,
      });
    }

    // Also check discussions
    for (const discussion of discussions) {
      for (const note of discussion.notes) {
        if (note.system) continue;
        if (this.isBotAuthor(note.author.username)) continue;

        comments.push({
          author: note.author.username,
          body: note.body,
          createdAt: note.created_at,
        });
      }
    }

    return comments;
  }

  /**
   * Get recently merged MRs for learning loop
   */
  async getRecentlyMergedMRs(days: number): Promise<MergeRequest[]> {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceIso = since.toISOString();

    logger.info(`[${this.project.id}] Fetching merged MRs since ${sinceIso}`);

    const mrs = await this.client.listMergedMRs(sinceIso);
    return mrs.map(this.mapGitLabMR);
  }

  /**
   * Create a fix MR
   */
  async createFixMR(sourceBranch: string, targetBranch: string, originalMrIid: number): Promise<void> {
    const title = `Auto-fix: Review comments from !${originalMrIid}`;
    const description = `This MR was automatically created by CodeKeeper to address review comments from !${originalMrIid}.\n\nPlease review the changes carefully before merging.`;

    await this.client.createMergeRequest({
      sourceBranch,
      targetBranch,
      title,
      description,
    });

    logger.info(`[${this.project.id}] Created fix MR: ${sourceBranch} → ${targetBranch}`);
  }

  private mapGitLabMR = (mr: GitLabMR): MergeRequest => ({
    iid: mr.iid,
    title: mr.title,
    description: mr.description || '',
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    author: mr.author.username,
    draft: mr.draft,
    changesCount: parseInt(mr.changes_count, 10) || 0,
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    webUrl: mr.web_url,
  });

  private shouldReview(mr: MergeRequest, filter: ReviewFilter): boolean {
    // Exclude drafts
    if (filter.excludeDrafts && mr.draft) {
      logger.debug(`MR !${mr.iid} skipped: draft`);
      return false;
    }

    // Exclude authors
    if (filter.excludeAuthors.includes(mr.author)) {
      logger.debug(`MR !${mr.iid} skipped: excluded author ${mr.author}`);
      return false;
    }

    // Min changes
    if (mr.changesCount < filter.minChanges) {
      logger.debug(`MR !${mr.iid} skipped: too few changes (${mr.changesCount})`);
      return false;
    }

    // Max changes
    if (mr.changesCount > filter.maxChanges) {
      logger.warn(`MR !${mr.iid} skipped: too many changes (${mr.changesCount} > ${filter.maxChanges})`);
      return false;
    }

    return true;
  }

  private isBotAuthor(username: string): boolean {
    const botPatterns = ['bot', 'ci', 'codekeeper', 'gitlab', 'jenkins', 'github'];
    return botPatterns.some((p) => username.toLowerCase().includes(p));
  }

  private countLines(diff: string, prefix: string): number {
    return diff.split('\n').filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)).length;
  }
}
