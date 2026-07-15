/**
 * MR Agent 状态持久化工具
 *
 * 供 ReviewerRunner 和 MaintainerRunner 共享使用，
 * 记录已发布的 discussion 信息。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Project } from '../../../types.js';
import { getArchiveRoot } from '../../../types.js';
import type { ReviewFinding, MergeRequest } from '../../provider/types.js';

/**
 * 已发布 discussion 的记录项
 */
export interface PostedDiscussion {
  findingKey: string;
  discussionId: string;
  file: string;
  line: number;
  severity: ReviewFinding['severity'];
  resolved: boolean;
}

/**
 * 交互式 discussion 追踪项
 */
export interface InteractiveThread {
  /** 当前状态 */
  status: 'awaiting-reply';
  /** 提问时间戳 */
  askedAt: number;
  /** 上次提问内容 */
  question: string;
  /** 关联文件路径 */
  filePath?: string;
}

/**
 * Maintainer 对单条 finding 的决策记录
 */
export interface MaintainerFindingDecision {
  action: 'fix' | 'ask' | 'ignore';
  alreadyFixed?: boolean;
  reason: string;
  replyBody?: string;
  /** ask 时的问题 */
  question?: string;
  /** fix 时是否标记为删除文件 */
  deleteFile?: boolean;
  /** fix 失败时的累计重试次数 */
  failedAttempts: number;
  /** fix 是否已经成功 */
  fixSucceeded?: boolean;
  /** 该决策产生的时间戳 */
  decidedAt: number;
}

/**
 * Maintainer 对单个 discussion 的处理状态
 */
export interface MaintainerThreadState {
  /** findingKey -> 决策记录 */
  decisions: Record<string, MaintainerFindingDecision>;
  /** 该 discussion 下最近一条 Reviewer note 的时间戳（毫秒） */
  lastReviewerNoteAt: number;
  /** 上一次发布 summary 的时间戳 */
  lastSummaryAt?: number;
  /** 上一次发布 summary 的内容哈希，用于去重 */
  lastSummaryHash?: string;
}

/**
 * MR Agent 状态文件结构
 */
export interface MrAgentState {
  version: number;
  discussions: Record<string, PostedDiscussion[]>;
  /** 交互式 discussion 追踪 */
  interactiveThreads: Record<string, InteractiveThread>;
  /** 已处理过的非交互式 discussion，用于避免重复解析 */
  processedDiscussions?: Record<string, { noteCount: number; processedAt: number }>;
  /** Maintainer 对每个 discussion 的决策记忆与 summary 状态 */
  maintainerThreadState?: Record<string, MaintainerThreadState>;
  /** 每个分支对的最后一次评审状态，用于避免重复发布 summary/记忆 */
  reviewState?: Record<
    string,
    {
      findingsHash: string;
      findingsKeys: string[];
      reviewedAt: number;
      headSha?: string;
      /** 主 summary 评论的 note ID，用于检测 summary 是否被删除 */
      summaryNoteId?: number;
      /** 已记录到记忆的 Agent 评论 note ID，避免 summary/补充评论被重复记录 */
      reviewNoteIds?: number[];
      /** 上一次追加评审评论的 note ID，用于检测追加评论是否被删除 */
      lastAppendNoteId?: number;
      /** 上一次追加评审对应的 findings hash，用于避免重复追加 */
      lastAppendFindingsHash?: string;
    }
  >;
  /** Reviewer 对自己开的 discussion thread 的回复追踪，避免重复回复 */
  reviewerThreadState?: Record<string, { lastRepliedAt: number }>;
}

export function getStatePath(project: Project): string {
  const archiveRoot = getArchiveRoot(project);
  return join(archiveRoot, 'mr-agent-state.json');
}

export function loadState(project: Project): MrAgentState {
  const path = getStatePath(project);
  if (!existsSync(path)) {
    return { version: 1, discussions: {}, interactiveThreads: {} };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as MrAgentState;
    if (!parsed || typeof parsed !== 'object' || !parsed.discussions) {
      return { version: 1, discussions: {}, interactiveThreads: {} };
    }
    if (!parsed.interactiveThreads) {
      parsed.interactiveThreads = {};
    }
    if (!parsed.processedDiscussions) {
      parsed.processedDiscussions = {};
    }
    if (!parsed.reviewState) {
      parsed.reviewState = {};
    }
    if (!parsed.maintainerThreadState) {
      parsed.maintainerThreadState = {};
    }
    return parsed;
  } catch {
    return { version: 1, discussions: {}, interactiveThreads: {} };
  }
}

export function saveState(project: Project, state: MrAgentState): void {
  const path = getStatePath(project);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
}

export function getDiscussionStateKey(mr: MergeRequest): string {
  return `${mr.sourceBranch}:${mr.targetBranch}`;
}
