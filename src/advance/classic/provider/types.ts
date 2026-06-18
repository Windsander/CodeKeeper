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
  /** 评论者用户名 */
  author: string;
  /** 评论内容 */
  body: string;
  /** 创建时间 ISO 字符串 */
  createdAt: string;
  /** 是否已解决（可选，讨论类型才有） */
  resolved?: boolean;
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
 * 合并选项
 */
export interface MergeOptions {
  /** 合并后是否删除源分支 */
  shouldRemoveSourceBranch?: boolean;
  /** 流水线通过后自动合并 */
  mergeWhenPipelineSucceeds?: boolean;
}

/**
 * Git 平台抽象接口
 *
 * 所有方法返回 Promise，便于统一错误处理和重试策略。
 */
export interface IGitProvider {
  /** 列出所有开放的 MR */
  listOpenMRs(): Promise<MergeRequest[]>;

  /** 获取指定 MR 的 diff 列表 */
  getMRDiff(iid: number): Promise<MrDiff[]>;

  /** 在指定 MR 下发布评论 */
  postReviewComment(iid: number, body: string): Promise<void>;

  /** 获取指定 MR 的评审评论（已过滤系统 note 和 bot） */
  getReviewerComments(iid: number): Promise<ReviewerComment[]>;

  /** 获取指定 MR 的 CI 状态 */
  getCIStatus(iid: number): Promise<'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'unknown'>;

  /** 合并指定 MR */
  mergeMR(iid: number, options?: MergeOptions): Promise<void>;
}
