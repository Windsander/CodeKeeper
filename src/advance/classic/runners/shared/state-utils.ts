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
 * MR Agent 状态文件结构
 */
export interface MrAgentState {
  version: number;
  discussions: Record<string, PostedDiscussion[]>;
}

export function getStatePath(project: Project): string {
  const archiveRoot = getArchiveRoot(project);
  return join(archiveRoot, 'mr-agent-state.json');
}

export function loadState(project: Project): MrAgentState {
  const path = getStatePath(project);
  if (!existsSync(path)) {
    return { version: 1, discussions: {} };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as MrAgentState;
    if (!parsed || typeof parsed !== 'object' || !parsed.discussions) {
      return { version: 1, discussions: {} };
    }
    return parsed;
  } catch {
    return { version: 1, discussions: {} };
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
