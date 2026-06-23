import { logger } from '../core/logger.js';
import type { ProjectConfig } from '../types.js';

interface GitLabApiOptions {
  baseUrl: string;
  token: string;
}

export class GitLabClient {
  private baseUrl: string;
  private token: string;
  private projectId: string;

  constructor(
    project: ProjectConfig,
    options?: GitLabApiOptions
  ) {
    this.baseUrl = options?.baseUrl || project.gitlab.baseUrl;
    this.token = options?.token || project.gitlab.token;
    // URL-encode project path for GitLab API
    this.projectId = encodeURIComponent(project.gitlab.projectPath);
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v4${endpoint}`;

    const headers: Record<string, string> = {
      'PRIVATE-TOKEN': this.token,
      'Content-Type': 'application/json',
    };

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    logger.debug(`GitLab API ${method} ${endpoint}`);

    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ url, err: message }, `GitLab API fetch failed: ${method} ${endpoint}`);
      throw new Error(`GitLab API fetch failed: ${message}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({ status: response.status, body: errorText }, `GitLab API error: ${method} ${endpoint}`);
      throw new Error(`GitLab API ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * List open merge requests
   */
  async listMergeRequests(params?: {
    state?: string;
    per_page?: number;
    order_by?: string;
    sort?: string;
    author_username?: string;
    assignee_username?: string;
    reviewer_username?: string;
    labels?: string;
    source_branch?: string;
    target_branch?: string;
  }): Promise<GitLabMR[]> {
    const query = new URLSearchParams({
      state: params?.state || 'opened',
      per_page: String(params?.per_page || 50),
      order_by: params?.order_by || 'updated_at',
      sort: params?.sort || 'desc',
    });

    if (params?.author_username) query.set('author_username', params.author_username);
    if (params?.assignee_username) query.set('assignee_username', params.assignee_username);
    if (params?.reviewer_username) query.set('reviewer_username', params.reviewer_username);
    if (params?.labels) query.set('labels', params.labels);
    if (params?.source_branch) query.set('source_branch', params.source_branch);
    if (params?.target_branch) query.set('target_branch', params.target_branch);

    return this.request<GitLabMR[]>(
      'GET',
      `/projects/${this.projectId}/merge_requests?${query.toString()}`
    );
  }

  /**
   * List project members (including inherited members)
   */
  async listMembers(): Promise<GitLabMember[]> {
    return this.request<GitLabMember[]>(
      'GET',
      `/projects/${this.projectId}/members/all?per_page=100`
    );
  }

  /**
   * List project labels
   */
  async listLabels(): Promise<GitLabLabel[]> {
    return this.request<GitLabLabel[]>(
      'GET',
      `/projects/${this.projectId}/labels?per_page=100`
    );
  }

  /**
   * List protected branches
   */
  async listProtectedBranches(): Promise<GitLabProtectedBranch[]> {
    return this.request<GitLabProtectedBranch[]>(
      'GET',
      `/projects/${this.projectId}/protected_branches?per_page=100`
    );
  }

  /**
   * Get single merge request
   */
  async getMergeRequest(iid: number): Promise<GitLabMR> {
    return this.request<GitLabMR>(
      'GET',
      `/projects/${this.projectId}/merge_requests/${iid}`
    );
  }

  /**
   * Get MR changes (diff metadata)
   */
  async getMergeRequestChanges(iid: number): Promise<GitLabMRChanges> {
    return this.request<GitLabMRChanges>(
      'GET',
      `/projects/${this.projectId}/merge_requests/${iid}/changes?per_page=100`
    );
  }

  /**
   * Get MR notes (comments)
   */
  async getMergeRequestNotes(iid: number): Promise<GitLabNote[]> {
    return this.request<GitLabNote[]>(
      'GET',
      `/projects/${this.projectId}/merge_requests/${iid}/notes?per_page=100`
    );
  }

  /**
   * Get MR discussions
   */
  async getMergeRequestDiscussions(iid: number): Promise<GitLabDiscussion[]> {
    return this.request<GitLabDiscussion[]>(
      'GET',
      `/projects/${this.projectId}/merge_requests/${iid}/discussions?per_page=100`
    );
  }

  /**
   * Create a note (comment) on MR
   */
  async createNote(iid: number, body: string): Promise<GitLabNote> {
    return this.request<GitLabNote>(
      'POST',
      `/projects/${this.projectId}/merge_requests/${iid}/notes`,
      { body }
    );
  }

  /**
   * Resolve or unresolve a discussion on MR
   */
  async resolveDiscussion(
    iid: number,
    discussionId: string,
    resolved: boolean
  ): Promise<GitLabDiscussion> {
    return this.request<GitLabDiscussion>(
      'PUT',
      `/projects/${this.projectId}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}`,
      { resolved }
    );
  }

  /**
   * Add a note to an existing discussion on MR
   */
  async addDiscussionNote(
    iid: number,
    discussionId: string,
    body: string
  ): Promise<GitLabNote> {
    return this.request<GitLabNote>(
      'POST',
      `/projects/${this.projectId}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}/notes`,
      { body }
    );
  }

  /**
   * Create a discussion on MR
   */
  async createDiscussion(
    iid: number,
    body: string,
    position?: GitLabDiffPosition
  ): Promise<GitLabDiscussion> {
    const payload: Record<string, unknown> = { body };
    if (position) {
      payload.position = position;
    }
    return this.request<GitLabDiscussion>(
      'POST',
      `/projects/${this.projectId}/merge_requests/${iid}/discussions`,
      payload
    );
  }

  /**
   * Create a new merge request
   */
  async createMergeRequest(params: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description?: string;
  }): Promise<GitLabMR> {
    return this.request<GitLabMR>(
      'POST',
      `/projects/${this.projectId}/merge_requests`,
      {
        source_branch: params.sourceBranch,
        target_branch: params.targetBranch,
        title: params.title,
        description: params.description || '',
      }
    );
  }

  /**
   * List recently merged MRs (for learning loop)
   */
  async listMergedMRs(since?: string, perPage = 50): Promise<GitLabMR[]> {
    const query = new URLSearchParams({
      state: 'merged',
      per_page: String(perPage),
      order_by: 'updated_at',
      sort: 'desc',
    });

    if (since) {
      query.set('updated_after', since);
    }

    return this.request<GitLabMR[]>(
      'GET',
      `/projects/${this.projectId}/merge_requests?${query.toString()}`
    );
  }
}

// GitLab API response types
export interface GitLabMR {
  iid: number;
  title: string;
  description: string | null;
  source_branch: string;
  target_branch: string;
  author: { username: string; name: string };
  draft: boolean;
  changes_count: string;
  created_at: string;
  updated_at: string;
  web_url: string;
  state: string;
  merge_status: string;
  head_pipeline?: { status?: string };
}

export interface GitLabMember {
  username: string;
  name: string;
}

export interface GitLabLabel {
  name: string;
}

export interface GitLabProtectedBranch {
  name: string;
}

export interface GitLabMRChanges {
  changes: Array<{
    old_path: string;
    new_path: string;
    new_file: boolean;
    deleted_file: boolean;
    renamed_file: boolean;
    diff: string;
  }>;
}

export interface GitLabNote {
  id: number;
  body: string;
  author: { username: string; name: string };
  created_at: string;
  resolved: boolean;
  system: boolean;
}

export interface GitLabDiscussion {
  id: string;
  notes: GitLabNote[];
  resolvable: boolean;
  resolved: boolean;
}

export interface GitLabDiffPosition {
  base_sha: string;
  head_sha: string;
  start_sha: string;
  position_type: 'text';
  old_path: string;
  new_path: string;
  new_line: number;
  old_line?: number;
}
