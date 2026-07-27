/**
 * MR Agent 状态持久化工具
 *
 * 供 ReviewerRunner 和 MaintainerRunner 共享使用，
 * 记录已发布的 discussion 信息。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Project } from '../../../types.js';
import { getArchiveRoot } from '../../../types.js';
import type { ReviewFinding, MergeRequest } from '../../provider/types.js';
import type {
  MemoryFinding,
  MemoryFindingCase,
  MemoryReviewComment,
  ProjectKnowledgeItem,
} from '../../memory/types.js';

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

/** Discussion 远端回复与 resolve 的持久化投递状态。 */
export interface DiscussionDeliveryState {
  /** 已持久化的期望回复正文，重试时必须复用 */
  replyBody: string;
  /** 期望回复正文的稳定哈希 */
  replyHash: string;
  /** 回复发布状态 */
  replyStatus: 'pending' | 'posted' | 'failed';
  /** Git 平台返回的 note ID */
  replyNoteId?: number;
  /** 本次回复完成后是否需要 resolve */
  resolveRequired: boolean;
  /** resolve 状态 */
  resolveStatus: 'not-required' | 'pending' | 'resolved' | 'failed';
  /** 累计远端投递尝试次数 */
  attempts: number;
  /** 最近一次投递错误 */
  lastError?: string;
  /** 回复成功后是否应进入等待人工回复状态 */
  awaitingReply?: boolean;
  /** 等待回复时展示的提问正文 */
  question?: string;
  /** 等待回复关联的文件路径 */
  filePath?: string;
  /** 首次进入等待人工回复的时间戳，重启恢复时必须复用 */
  awaitingReplyAt?: number;
  /** 最近一次状态更新时间 */
  updatedAt: number;
}

/** MR 级普通评论的可恢复投递状态。 */
export interface ReviewCommentDeliveryState {
  body: string;
  bodyHash: string;
  status: 'pending' | 'posted' | 'failed';
  noteId?: number;
  attempts: number;
  lastError?: string;
  updatedAt: number;
}

export interface ReviewerReviewMemoryPayload {
  mrIid: number;
  title: string;
  findingsCount: number;
  summary: string;
  findings: MemoryFinding[];
  comments: MemoryReviewComment[];
  mrAuthor?: string;
}

export interface ReviewerMemoryState {
  review?: {
    key: string;
    status: 'pending' | 'recorded' | 'failed';
    payload: ReviewerReviewMemoryPayload;
    attempts: number;
    lastError?: string;
    updatedAt: number;
  };
  findingCases?: {
    key: string;
    status: 'pending' | 'recorded' | 'failed';
    cases: MemoryFindingCase[];
    attempts: number;
    lastError?: string;
    updatedAt: number;
  };
}

export interface ArchiverState {
  sourceFingerprint: string;
  items: Record<
    string,
    {
      item: ProjectKnowledgeItem;
      status: 'pending' | 'recorded' | 'failed';
      attempts: number;
      lastError?: string;
      updatedAt: number;
    }
  >;
  updatedAt: number;
}

/** 状态文件的写入方，用于隔离独立 Role Agent 之间的字段覆盖。 */
export type StateOwner = 'reviewer' | 'maintainer' | 'archiver' | 'all';

const STATE_LOCK_TIMEOUT_MS = 10_000;
const STATE_LOCK_STALE_MS = 60_000;

/**
 * 锁目录始终为空，必须使用 rmdirSync。
 * 部分 Windows + Node 25 环境在中文路径上调用递归 rmSync 会无报错但保留目标目录。
 */
function removeStateLock(lockPath: string): void {
  try {
    rmdirSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** 中文路径下使用 unlinkSync，避免 rmSync 静默保留临时文件。 */
function removeTempStateFile(tempPath: string): void {
  try {
    unlinkSync(tempPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function createEmptyState(): MrAgentState {
  return { version: 1, discussions: {}, interactiveThreads: {} };
}

function normalizeState(parsed: MrAgentState): MrAgentState {
  parsed.version ??= 1;
  parsed.interactiveThreads ??= {};
  parsed.processedDiscussions ??= {};
  parsed.reviewState ??= {};
  parsed.maintainerThreadState ??= {};
  parsed.reviewerThreadState ??= {};
  parsed.reviewCommentDelivery ??= {};
  return parsed;
}

function readStateFile(path: string): MrAgentState | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as MrAgentState;
    if (!parsed || typeof parsed !== 'object' || !parsed.discussions) return undefined;
    return normalizeState(parsed);
  } catch {
    return undefined;
  }
}

function readLatestState(project: Project): MrAgentState {
  const path = getStatePath(project);
  const current = readStateFile(path);
  if (current) return current;
  const backup = readStateFile(`${path}.bak`);
  return backup ?? createEmptyState();
}

function mergeOwnedState(
  latest: MrAgentState,
  incoming: MrAgentState,
  owner: Exclude<StateOwner, 'all'>
): MrAgentState {
  const merged = normalizeState({ ...latest });
  merged.version = incoming.version ?? merged.version;

  if (owner === 'reviewer') {
    merged.discussions = incoming.discussions;
    if (incoming.reviewState !== undefined) merged.reviewState = incoming.reviewState;
    if (incoming.reviewerThreadState !== undefined) {
      merged.reviewerThreadState = incoming.reviewerThreadState;
    }
    if (incoming.reviewCommentDelivery !== undefined) {
      merged.reviewCommentDelivery = incoming.reviewCommentDelivery;
    }
  } else if (owner === 'maintainer') {
    if (incoming.interactiveThreads !== undefined) {
      merged.interactiveThreads = incoming.interactiveThreads;
    }
    if (incoming.processedDiscussions !== undefined) {
      merged.processedDiscussions = incoming.processedDiscussions;
    }
    if (incoming.maintainerThreadState !== undefined) {
      merged.maintainerThreadState = incoming.maintainerThreadState;
    }
  } else if (incoming.archiverState !== undefined) {
    merged.archiverState = incoming.archiverState;
  }

  return normalizeState(merged);
}

/** 获取跨进程状态目录锁；异常退出留下的陈旧锁会自动回收。 */
function acquireStateLock(lockPath: string): void {
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

  while (Date.now() < deadline) {
    try {
      // mkdir 是跨平台的原子创建操作，避免文件锁释放时的 close/unlink 竞态。
      mkdirSync(lockPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;

      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STATE_LOCK_STALE_MS) {
          removeStateLock(lockPath);
          continue;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw lockError;
      }

      Atomics.wait(waitBuffer, 0, 0, 25);
    }
  }

  throw new Error(`获取状态文件锁超时: ${lockPath}`);
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
  /**
   * 最近一次 fix 尝试失败的真实原因（如批量修复返回的失败描述）。
   * 复用历史决策生成失败汇总时应展示它，而不是决策理由 reason。
   */
  lastFailureReason?: string;
  /** 该决策产生的时间戳 */
  decidedAt: number;
}

/**
 * Maintainer 对单个 discussion 的处理状态
 */
export interface MaintainerThreadState {
  /** findingKey -> 决策记录 */
  decisions: Record<string, MaintainerFindingDecision>;
  /** 最近一次解析得到的有效 finding key；历史孤儿状态不再驱动重试。 */
  activeFindingKeys?: string[];
  /** 该 discussion 下最近一条 Reviewer note 的时间戳（毫秒） */
  lastReviewerNoteAt: number;
  /**
   * 该 discussion 下最近一条「人工」note 的时间戳（毫秒）。
   * 只有人工新回复才可能改变已有结论；Agent 自动重扫不带新信息，不触发重评估。
   */
  lastHumanNoteAt?: number;
  /**
   * 该 discussion 已被判定为「批量统计/指标聚合报告」。
   * 命中后静默跳过（不修复、不回复），并借此避免每轮轮询重复调用 LLM 判定。
   */
  statisticalReport?: boolean;
  /**
   * 非 finding 讨论的处理结果记录。
   * 作为「已处理」证据：只有记录了的非 finding 讨论才可被过滤逻辑安全跳过，
   * 避免旧版本只发过轻松回复/提问（无任何记录）的讨论被永久压住。
   */
  nonFindingAction?: 'record' | 'ask' | 'ignore';
  /** 上一次发布 summary 的时间戳 */
  lastSummaryAt?: number;
  /** 上一次发布 summary 的内容哈希，用于去重 */
  lastSummaryHash?: string;
  /** 当前或最近一次远端回复投递状态 */
  delivery?: DiscussionDeliveryState;
  lastProcessedHeadSha?: string;
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
      reviewNoteHeadShas?: Record<string, string>;
      /** 上一次追加评审评论的 note ID，用于检测追加评论是否被删除 */
      lastAppendNoteId?: number;
      /** 上一次追加评审对应的 findings hash，用于避免重复追加 */
      lastAppendFindingsHash?: string;
      memory?: ReviewerMemoryState;
    }
  >;
  /** Reviewer 对自己开的 discussion thread 的回复追踪，避免重复回复 */
  reviewerThreadState?: Record<
    string,
    {
      lastRepliedAt: number;
      delivery?: DiscussionDeliveryState;
      pendingTargetNoteId?: number;
      pendingTargetCreatedAt?: number;
    }
  >;
  /** Reviewer MR summary/追加评论的可恢复投递状态。 */
  reviewCommentDelivery?: Record<
    string,
    { summary?: ReviewCommentDeliveryState; append?: ReviewCommentDeliveryState }
  >;
  /** Archiver 项目知识批次的可恢复状态。 */
  archiverState?: ArchiverState;
}

export function getStatePath(project: Project): string {
  const archiveRoot = getArchiveRoot(project);
  return join(archiveRoot, 'mr-agent-state.json');
}

export function loadState(project: Project): MrAgentState {
  const path = getStatePath(project);
  const current = readStateFile(path);
  if (current) return current;
  return readStateFile(`${path}.bak`) ?? createEmptyState();
}

/** 原子保存状态，并在正式文件损坏时保留上一版备份。 */
export function saveState(project: Project, state: MrAgentState, owner: StateOwner = 'all'): void {
  const path = getStatePath(project);
  const tempPath = `${path}.tmp-${process.pid}`;
  const backupPath = `${path}.bak`;
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  acquireStateLock(lockPath);

  try {
    const latest = readLatestState(project);
    const nextState =
      owner === 'all' ? normalizeState({ ...state }) : mergeOwnedState(latest, state, owner);
    const serialized = JSON.stringify(nextState, null, 2);
    writeFileSync(tempPath, serialized, 'utf-8');

    // 只有当前正式文件可解析时才更新备份，避免坏文件覆盖掉可恢复的备份。
    if (readStateFile(path)) copyFileSync(path, backupPath);

    try {
      renameSync(tempPath, path);
    } catch {
      // Windows 某些文件锁场景无法直接 rename 覆盖，退化为有备份保护的写入。
      writeFileSync(path, serialized, 'utf-8');
    } finally {
      removeTempStateFile(tempPath);
    }
  } finally {
    removeStateLock(lockPath);
  }
}

export function getDiscussionStateKey(mr: MergeRequest): string {
  return `${mr.sourceBranch}:${mr.targetBranch}`;
}
