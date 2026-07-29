/**
 * IGitProvider 接口定义 — CodeKeeper Advance Classic 模式
 *
 * 抽象 Git 平台（GitLab / GitHub / Gitea 等）的 MR 操作，
 * 使 Reviewer 和状态机不依赖具体平台实现。
 */

/**
 * 合并请求基本信息
 */
export interface MergeRequest {
  /** MR 内部编号 */
  iid: number;
  /** 标题 */
  title: string;
  /** 描述 */
  description: string;
  /** 源分支 */
  sourceBranch: string;
  /** 目标分支 */
  targetBranch: string;
  /** 作者用户名 */
  author: string;
  /** 是否为草稿 */
  draft: boolean;
  /** 变更文件数 */
  changesCount: number;
  /** 创建时间 ISO 字符串 */
  createdAt: string;
  /** 更新时间 ISO 字符串 */
  updatedAt: string;
  /** Web 页面 URL */
  webUrl: string;
  /** 被指派人用户名（可选，用于过滤） */
  assignee?: string;
  /** 评审人用户名列表（可选，用于过滤） */
  reviewers?: string[];
  /** 标签列表（可选，用于过滤） */
  labels?: string[];
}

/**
 * 单个文件的 diff 信息
 */
export interface MrDiff {
  /** 文件路径 */
  filePath: string;
  /** 旧路径（重命名时不同） */
  oldPath: string;
  /** 新路径 */
  newPath: string;
  /** 是否新增文件 */
  newFile: boolean;
  /** 是否删除文件 */
  deletedFile: boolean;
  /** diff 文本 */
  diff: string;
  /** 新增行数 */
  additions: number;
  /** 删除行数 */
  deletions: number;
}

/**
 * 评审评论
 */
export interface ReviewerComment {
  /** 评论 ID，用于区分已记录的 Agent summary 评论 */
  id: number;
  /** 评论者用户名 */
  author: string;
  /** 评论内容 */
  body: string;
  /** 创建时间 ISO 字符串 */
  createdAt: string;
  /** 最近编辑时间 ISO 字符串 */
  updatedAt?: string;
  /** 是否已解决（可选，讨论类型才有） */
  resolved?: boolean;
}

/** 远端全量事实与 Agent 活跃分析窗口。 */
export interface RemoteActivitySnapshot<T> {
  /** 全量远端事实，用于 ID、正文和删除状态对账 */
  all: T[];
  /** 最近活跃窗口，用于 Agent 分析 */
  active: T[];
}

/** Reviewer 评论快照，额外提供排除自动账号后的活跃评论。 */
export interface ReviewerCommentSnapshot extends RemoteActivitySnapshot<ReviewerComment> {
  activeHuman: ReviewerComment[];
}

/**
 * 评审发现项
 */
export interface ReviewFinding {
  /** 严重程度 */
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  /** 文件路径 */
  file: string;
  /** 行号 */
  line: number;
  /** 规则编号（可选） */
  ruleId?: string;
  /** 评审消息 */
  message: string;
  /** 修改建议 */
  suggestion: string;
  /** 是否可自动修复（可选） */
  autoFixable?: boolean;
}

/**
 * 评审结果
 */
export interface ReviewResult {
  /** 发现项列表 */
  findings: ReviewFinding[];
  /** 评审总结 */
  summary: string;
  /** 可自动修复的索引列表 */
  autoFixable: number[];
  /** 原始 LLM 响应（可选） */
  rawResponse?: string;
}

/**
 * MR discussion（讨论线程）
 */
export interface Discussion {
  id: string;
  resolvable: boolean;
  resolved: boolean;
  notes: ReviewerComment[];
  /** diff discussion 的代码位置信息（可选） */
  position?: {
    newPath: string;
    newLine?: number;
    oldPath?: string;
    oldLine?: number;
    headSha?: string;
  };
}

/**
 * 合并选项
 */
export interface MergeOptions {
  /** 合并后是否删除源分支 */
  shouldRemoveSourceBranch?: boolean;
  /** 流水线通过后自动合并 */
  mergeWhenPipelineSucceeds?: boolean;
}

/**
 * Git diff position，用于把 discussion 定位到具体代码行
 */
export interface GitLabDiffPosition {
  baseSha: string;
  headSha: string;
  startSha: string;
  positionType: 'text';
  oldPath: string;
  newPath: string;
  newLine: number;
  oldLine?: number;
}

/**
 * MR 的 SHA 信息，用于构造 diff position
 */
export interface MrShaInfo {
  baseSha: string;
  headSha: string;
  startSha: string;
}

/** MR 生命周期终态感知所需的概览信息。 */
export interface MrOverview {
  /** GitLab MR 状态：opened / merged / closed / locked */
  state: string;
  /** 当前 head SHA（可能缺失） */
  headSha?: string;
  /** 标签列表 */
  labels: string[];
}

/** CI 失败 job 的诊断信息。 */
export interface CiFailedJob {
  id: number;
  name: string;
  stage: string;
  /** GitLab 失败原因枚举（如 script_failure / runner_system_failure） */
  failureReason?: string;
  /** 日志尾部片段，用于定位失败根因 */
  traceTail: string;
  webUrl?: string;
}

/** 指定 MR 的 CI 失败报告；status 非 failed 时 failedJobs 为空。 */
export interface CiFailureReport {
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'unknown';
  pipelineId?: number;
  pipelineSha?: string;
  pipelineWebUrl?: string;
  failedJobs: CiFailedJob[];
}

import type { MrReviewFilter } from '../../types.js';

/**
 * Git 平台抽象接口
 *
 * 所有方法返回 Promise，便于统一错误处理和重试策略。
 */
export interface IGitProvider {
  /** 列出所有开放的 MR，可选按过滤条件筛选 */
  listOpenMRs(filters?: MrReviewFilter): Promise<MergeRequest[]>;

  /** 列出项目成员 */
  listMembers(): Promise<Array<{ username: string; name?: string }>>;

  /** 列出项目标签 */
  listLabels(): Promise<string[]>;

  /** 列出项目保护分支 */
  listProtectedBranches(): Promise<string[]>;

  /** 列出项目所有分支 */
  listBranches(): Promise<string[]>;

  /** 验证当前仓库配置是否可连通 */
  verify(): Promise<void>;

  /** 获取指定 MR 的 diff 列表 */
  getMRDiff(iid: number): Promise<MrDiff[]>;

  /** 获取指定 MR 的 SHA 信息 */
  getMRShaInfo(iid: number): Promise<MrShaInfo>;

  /** 在指定 MR 下发布评论，返回创建的 note ID */
  postReviewComment(iid: number, body: string): Promise<number>;

  /** 在指定 MR 下创建 discussion thread（可选定位到代码行） */
  createDiscussion(iid: number, body: string, position?: GitLabDiffPosition): Promise<string>;

  /** 获取指定 MR 的所有 discussions */
  getDiscussions(iid: number): Promise<Discussion[]>;

  /** 获取指定 MR 的全量 discussion 与最近活动窗口 */
  getDiscussionSnapshot(iid: number): Promise<RemoteActivitySnapshot<Discussion>>;

  /** resolve 或 unresolve 指定 discussion */
  resolveDiscussion(iid: number, discussionId: string, resolved?: boolean): Promise<void>;

  /** 在指定 discussion 下追加 note，返回创建的 note ID */
  addDiscussionNote(iid: number, discussionId: string, body: string): Promise<number>;

  /** 获取指定 MR 的评审评论（已过滤系统 note 和 bot） */
  getReviewerComments(iid: number): Promise<ReviewerComment[]>;

  /** 获取指定 MR 的全量评论、活动窗口与人工评论窗口 */
  getReviewerCommentSnapshot(iid: number): Promise<ReviewerCommentSnapshot>;

  /** 获取指定 MR 的 CI 状态 */
  getCIStatus(iid: number): Promise<'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'unknown'>;

  /** 获取指定 MR 的概览（生命周期终态感知） */
  getMROverview(iid: number): Promise<MrOverview>;

  /** 获取指定 MR 的 CI 失败报告（含失败 job 日志尾部） */
  getCiFailureReport(iid: number): Promise<CiFailureReport>;

  /** 合并指定 MR */
  mergeMR(iid: number, options?: MergeOptions): Promise<void>;
}
