/**
 * 管线运行持久化：pipeline_runs / stage_runs 的 CRUD。
 *
 * 每个节点边界落库是"持久化执行"的基础：一条管线可能跨天等待外部事件，
 * 进程重启后可从最近成功的节点继续（见 executor.resume）。
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PipelineDefinition } from './types.js';

export type PipelineRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type StageRunStatus = 'running' | 'succeeded' | 'failed' | 'skipped';

export interface PipelineRunRecord {
  id: string;
  pipelineId: string;
  projectId: string | null;
  status: PipelineRunStatus;
  definition: PipelineDefinition;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface StageRunRecord {
  id: string;
  runId: string;
  nodeId: string;
  status: StageRunStatus;
  inputs: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

interface RunRow {
  id: string;
  pipeline_id: string;
  project_id: string | null;
  status: PipelineRunStatus;
  definition_json: string;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

interface StageRow {
  id: string;
  run_id: string;
  node_id: string;
  status: StageRunStatus;
  inputs_json: string | null;
  outputs_json: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

export class PipelineRunStore {
  constructor(private readonly db: Database.Database) {}

  createRun(pipelineId: string, definition: PipelineDefinition, projectId?: string): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO pipeline_runs (id, pipeline_id, project_id, status, definition_json, created_at)
         VALUES (?, ?, ?, 'running', ?, ?)`
      )
      .run(id, pipelineId, projectId ?? null, JSON.stringify(definition), Date.now());
    return id;
  }

  finishRun(runId: string, status: Exclude<PipelineRunStatus, 'running'>, error?: string): void {
    this.db
      .prepare('UPDATE pipeline_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(status, error ?? null, Date.now(), runId);
  }

  getRun(runId: string): PipelineRunRecord | null {
    const row = this.db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(runId) as
      | RunRow
      | undefined;
    return row ? toRunRecord(row) : null;
  }

  listRuns(pipelineId?: string, limit = 50): PipelineRunRecord[] {
    const rows = (
      pipelineId
        ? this.db
            .prepare(
              'SELECT * FROM pipeline_runs WHERE pipeline_id = ? ORDER BY created_at DESC LIMIT ?'
            )
            .all(pipelineId, limit)
        : this.db.prepare('SELECT * FROM pipeline_runs ORDER BY created_at DESC LIMIT ?').all(limit)
    ) as RunRow[];
    return rows.map(toRunRecord);
  }

  /**
   * 节点开始执行：新建或重置该节点的 stage 记录（resume 重跑时复用同一行）。
   * 注意：仅 executor 在确认节点未成功时才应调用；重置会抹掉上一次尝试的
   * inputs/outputs/error，不保留 attempt 历史。
   */
  beginStage(runId: string, nodeId: string, inputs: Record<string, unknown>): string {
    const existing = this.db
      .prepare('SELECT id FROM stage_runs WHERE run_id = ? AND node_id = ?')
      .get(runId, nodeId) as { id: string } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE stage_runs
           SET status = 'running', inputs_json = ?, outputs_json = NULL, error = NULL,
               started_at = ?, finished_at = NULL
           WHERE id = ?`
        )
        .run(JSON.stringify(inputs), Date.now(), existing.id);
      return existing.id;
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO stage_runs (id, run_id, node_id, status, inputs_json, started_at)
         VALUES (?, ?, ?, 'running', ?, ?)`
      )
      .run(id, runId, nodeId, JSON.stringify(inputs), Date.now());
    return id;
  }

  finishStage(
    stageId: string,
    status: Exclude<StageRunStatus, 'running'>,
    outputs?: Record<string, unknown>,
    error?: string
  ): void {
    this.db
      .prepare(
        'UPDATE stage_runs SET status = ?, outputs_json = ?, error = ?, finished_at = ? WHERE id = ?'
      )
      .run(status, outputs ? JSON.stringify(outputs) : null, error ?? null, Date.now(), stageId);
  }

  getStageRuns(runId: string): StageRunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM stage_runs WHERE run_id = ? ORDER BY started_at ASC, rowid ASC')
      .all(runId) as StageRow[];
    return rows.map(toStageRecord);
  }

  /** resume 用：已成功节点的输出产物表（nodeId -> outputs） */
  getSucceededOutputs(runId: string): Map<string, Record<string, unknown>> {
    const rows = this.db
      .prepare(
        "SELECT node_id, outputs_json FROM stage_runs WHERE run_id = ? AND status = 'succeeded'"
      )
      .all(runId) as Array<{ node_id: string; outputs_json: string | null }>;
    const map = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      map.set(row.node_id, row.outputs_json ? JSON.parse(row.outputs_json) : {});
    }
    return map;
  }
}

function toRunRecord(row: RunRow): PipelineRunRecord {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    projectId: row.project_id,
    status: row.status,
    definition: JSON.parse(row.definition_json) as PipelineDefinition,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function toStageRecord(row: StageRow): StageRunRecord {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    status: row.status,
    inputs: row.inputs_json ? JSON.parse(row.inputs_json) : null,
    outputs: row.outputs_json ? JSON.parse(row.outputs_json) : null,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
