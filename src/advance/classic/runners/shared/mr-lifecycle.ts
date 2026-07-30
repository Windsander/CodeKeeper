/**
 * Maintainer 单 MR 全生命周期自治管理
 *
 * 为 Maintainer 的周期轮询提供「单 MR 视角」的生命周期状态：
 * - 跟踪 MR 从发现到 merged/closed/用户中断的完整过程；
 * - 聚合讨论闭环、修复/拒绝/挂起与 CI 修复指标，支撑收敛效率度量；
 * - MR 进入终态（merged/closed/interrupted）时优雅退出并归档。
 *
 * 本模块只包含可独立测试的纯函数与状态类型；远端交互由 MaintainerRunner 编排。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Discussion, ReviewerComment, CiFailedJob } from '../../provider/types.js';

/** 单个 head 上允许的最大 CI 自动修复尝试次数；超过则挂起等待人工 */
export const MAX_CI_FIX_ATTEMPTS_PER_HEAD = 2;

/** MR 生命周期记录在状态文件中的 key 前缀 */
export const MR_LIFECYCLE_KEY_PREFIX = 'mr:';

export function buildMrLifecycleKey(mrIid: number): string {
  return `${MR_LIFECYCLE_KEY_PREFIX}${mrIid}`;
}

/** CI 修复进展的生命周期子状态 */
export interface MrLifecycleCiState {
  /** 最近一次观测到的 MR head SHA */
  lastHeadSha?: string;
  /** 最近一次观测到的 CI 状态 */
  lastStatus?: string;
  /** 最近一次 CI 失败 job 集合哈希，用于识别「同一次失败」 */
  lastFailedJobsHash?: string;
  /** 当前 head 上的 CI 修复尝试次数 */
  fixAttempts: number;
  /** 累计 CI 修复推送次数 */
  totalFixPushes: number;
  /** CI 修复进展关联的 discussion ID（由 Maintainer 创建） */
  discussionId?: string;
  /** 多次修复未果后挂起，等待人工介入 */
  suspended?: boolean;
  /** 挂起原因 */
  suspendReason?: string;
  updatedAt: number;
}

/** MR 全生命周期聚合指标 */
export interface MrLifecycleMetrics {
  /** resolvable discussion 总数 */
  discussionsTotal: number;
  /** 已 resolve 的 discussion 数 */
  discussionsResolved: number;
  /** 自动修复成功的 finding 数 */
  findingsFixed: number;
  /** 判定为不合理/无需修复并记录拒绝理由的 finding 数（辩） */
  findingsRejected: number;
  /** 挂起等待人工澄清的 finding 数（挂起） */
  findingsSuspended: number;
  /** 代码推送总次数（reviewer 意见 + CI 修复） */
  fixPushes: number;
  /**
   * 修复后仍收到人工追评的次数。
   * 作为「误修」信号：自动修复结论被人工再次质疑。
   */
  humanFollowupsAfterFix: number;
  // ---- M 系列过程指标（可选，兼容旧归档；达标线见 docs/goals/maintainer-llm-centric-goal.md） ----
  /** M1 只读熔断前动用了「最后一轮行动机会」的轮数 */
  readOnlyFinalActingRounds?: number;
  /** M2 commit 首次尝试即成功（未经合规改写）次数 */
  commitFirstTryPasses?: number;
  /** M3 commit 首次尝试被合规校验拒绝、进入兜底改写的次数 */
  commitFirstTryRejections?: number;
  /** M4 补发说明/汇总命中「已发过、跳过」的次数（去重生效） */
  duplicateSummarySkips?: number;
  /** M5 ask 门禁拦截（自答问题转修复自查）次数 */
  askGateInterceptions?: number;
  /** M6 hook 失败（lint/test/typecheck）后回流的次数 */
  hookFailureReflows?: number;
}

/** 用户中断指令记录 */
export interface MrLifecycleInterrupt {
  /** 发出指令的用户名 */
  by: string;
  /** 命中指令的评论正文片段 */
  command: string;
  /** 指令时间戳（毫秒） */
  at: number;
}

/** 单 MR 全生命周期状态 */
export interface MrLifecycleState {
  mrIid: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  webUrl?: string;
  /** active：自治维护中；converged：意见已收敛等待合并；archived：已退出并归档 */
  status: 'active' | 'converged' | 'archived';
  /** 归档原因 */
  endReason?: 'merged' | 'closed' | 'interrupted';
  startedAt: number;
  lastPolledAt: number;
  pollCount: number;
  metrics: MrLifecycleMetrics;
  interrupted?: MrLifecycleInterrupt;
  ci?: MrLifecycleCiState;
  archivedAt?: number;
  /** 归档文件绝对路径 */
  archivePath?: string;
}

export function createLifecycleState(mr: {
  iid: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  webUrl?: string;
}): MrLifecycleState {
  const now = Date.now();
  return {
    mrIid: mr.iid,
    title: mr.title,
    sourceBranch: mr.sourceBranch,
    targetBranch: mr.targetBranch,
    webUrl: mr.webUrl,
    status: 'active',
    startedAt: now,
    lastPolledAt: now,
    pollCount: 0,
    metrics: {
      discussionsTotal: 0,
      discussionsResolved: 0,
      findingsFixed: 0,
      findingsRejected: 0,
      findingsSuspended: 0,
      fixPushes: 0,
      humanFollowupsAfterFix: 0,
    },
  };
}

/**
 * 用户中断指令模式。
 *
 * 判定刻意保守：只匹配明确的停止指令，避免把「先别修这一条」之类的普通
 * 讨论误判为全局中断。仅对人工发布的 note 生效。
 */
const INTERRUPT_PATTERNS: RegExp[] = [
  /\/(?:ck|codekeeper|maintainer)[\s-]+(?:stop|halt|pause|abort)\b/i,
  /@(?:codekeeper|maintainer)\S*\s+(?:stop|halt|pause)\b/i,
  /停止自动(?:修复|维护|处理)/,
  /暂停自动(?:修复|维护|处理)/,
  /不要再?自动(?:修复|修改|提交)/,
];

export interface InterruptDetectionInput {
  author: string;
  body: string;
  createdAt: string;
}

/**
 * 在评论中识别用户中断指令。
 *
 * @param notes 候选评论（MR 级评论与 discussion note 均可）
 * @param isHuman 判断作者是否为人工（非 Agent/bot）的回调
 * @returns 最新一条命中指令，无命中返回 undefined
 */
export function detectInterruptCommand(
  notes: InterruptDetectionInput[],
  isHuman: (author: string, body: string) => boolean
): MrLifecycleInterrupt | undefined {
  let latest: MrLifecycleInterrupt | undefined;
  for (const note of notes) {
    if (!isHuman(note.author, note.body)) continue;
    const hit = INTERRUPT_PATTERNS.some(pattern => pattern.test(note.body));
    if (!hit) continue;
    const at = Date.parse(note.createdAt) || Date.now();
    if (!latest || at > latest.at) {
      latest = {
        by: note.author,
        command: note.body.slice(0, 200),
        at,
      };
    }
  }
  return latest;
}

/** discussion 闭环统计 */
export interface DiscussionClosureStats {
  /** resolvable discussion 总数 */
  total: number;
  /** 已 resolve 数 */
  resolved: number;
  /** 闭环率（total 为 0 时为 1） */
  closureRate: number;
}

export function computeClosureStats(discussions: Discussion[]): DiscussionClosureStats {
  const resolvable = discussions.filter(d => d.resolvable);
  const resolved = resolvable.filter(d => d.resolved).length;
  return {
    total: resolvable.length,
    resolved,
    closureRate: resolvable.length === 0 ? 1 : resolved / resolvable.length,
  };
}

/**
 * 判定 MR 是否已收敛：
 * - 没有待处理的 discussion；
 * - 全部 resolvable discussion 均已 resolve；
 * - CI 未处于失败状态；
 * - CI 修复未处于挂起状态（挂起说明还有未闭环事项）。
 */
export function isMrConverged(input: {
  pendingDiscussionCount: number;
  closure: DiscussionClosureStats;
  ciStatus?: string;
  ciSuspended?: boolean;
}): boolean {
  if (input.pendingDiscussionCount > 0) return false;
  if (input.closure.total > 0 && input.closure.resolved < input.closure.total) return false;
  if (input.ciStatus === 'failed') return false;
  if (input.ciSuspended) return false;
  return true;
}

/** CI 失败的修复策略分类 */
export type CiFailureKind = 'code' | 'infra' | 'unknown';

/**
 * GitLab job failure_reason 中明确属于基础设施/环境问题、无法通过修改代码修复的类型。
 */
const INFRA_FAILURE_REASONS = new Set([
  'runner_system_failure',
  'runner_unsupported',
  'stuck_or_timeout_failure',
  'scheduler_failure',
  'api_failure',
  'unknown_failure',
  'job_execution_timeout',
  'job_snapshot_timeout',
  'unmet_prerequisites',
  'data_integrity_failure',
]);

/**
 * 对 CI 失败做「修/挂起」分类：
 * - infra：runner/调度/超时等基础设施失败，修改代码无意义 → 挂起；
 * - code：script_failure 等可通过修改代码修复 → 尝试最小修复；
 * - unknown：无失败原因时按 trace 内容兜底判断。
 */
export function classifyCiFailure(
  job: Pick<CiFailedJob, 'failureReason' | 'traceTail'>
): CiFailureKind {
  if (job.failureReason) {
    if (INFRA_FAILURE_REASONS.has(job.failureReason)) return 'infra';
    if (job.failureReason === 'script_failure') return 'code';
  }
  const trace = job.traceTail.toLowerCase();
  if (
    trace.includes('no runner') ||
    trace.includes('runner unavailable') ||
    trace.includes('network is unreachable') ||
    trace.includes('could not resolve host') ||
    trace.includes('job timeout')
  ) {
    return 'infra';
  }
  return job.failureReason ? 'code' : 'unknown';
}

/** 计算失败 job 集合的稳定哈希，用于识别同一轮失败是否已处理过（不含 job id，跨 pipeline 复跑保持稳定） */
export function hashFailedJobs(jobs: Array<Pick<CiFailedJob, 'name' | 'stage'>>): string {
  const keys = jobs.map(job => `${job.stage}/${job.name}`).sort();
  let h = 0;
  const text = keys.join('|');
  for (let i = 0; i < text.length; i++) {
    h = (h << 5) - h + text.charCodeAt(i);
    h |= 0;
  }
  return String(h);
}

/**
 * 从 CI 日志中提取可能存在的仓库文件路径候选。
 *
 * 只保留形如 `src/foo/bar.ts` 的相对路径，排除 URL、绝对路径与 node_modules，
 * 供调用方用 worktree 逐一验证存在性。
 */
export function extractFileCandidatesFromTrace(traceTail: string, maxCandidates = 5): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pattern = /(?:^|[\s('"`])((?:[\w@-]+\/)+[\w@.[\]-]+\.[a-zA-Z0-9]{1,10})(?::\d+(?::\d+)?)?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(traceTail)) !== null) {
    const candidate = match[1];
    if (candidate.startsWith('node_modules/') || candidate.includes('/node_modules/')) continue;
    if (candidate.startsWith('http') || candidate.startsWith('/')) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
    if (candidates.length >= maxCandidates) break;
  }
  return candidates;
}

/** 归档记录：生命周期状态 + 终态快照，写入项目归档目录 */
export interface MrLifecycleArchiveRecord {
  version: 1;
  archivedAt: string;
  projectId: string;
  lifecycle: MrLifecycleState;
  /** 终态时的 discussion 闭环快照 */
  closure: DiscussionClosureStats;
}

/**
 * 将生命周期记录归档到 `<archiveRoot>/maintainer-lifecycle/`。
 *
 * @returns 归档文件绝对路径
 */
export function archiveLifecycleRecord(
  archiveRoot: string,
  projectId: string,
  lifecycle: MrLifecycleState,
  closure: DiscussionClosureStats
): string {
  const dir = join(archiveRoot, 'maintainer-lifecycle');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const record: MrLifecycleArchiveRecord = {
    version: 1,
    archivedAt: new Date().toISOString(),
    projectId,
    lifecycle,
    closure,
  };

  const filePath = join(dir, `mr-${lifecycle.mrIid}-${Date.now()}.json`);
  writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
  return filePath;
}

/**
 * 汇总 MR 级评论与 discussion note，供中断指令扫描使用。
 */
export function collectInterruptCandidates(
  mrNotes: ReviewerComment[],
  discussions: Discussion[]
): InterruptDetectionInput[] {
  const candidates: InterruptDetectionInput[] = mrNotes.map(note => ({
    author: note.author,
    body: note.body,
    createdAt: note.createdAt,
  }));
  for (const discussion of discussions) {
    for (const note of discussion.notes) {
      candidates.push({ author: note.author, body: note.body, createdAt: note.createdAt });
    }
  }
  return candidates;
}
