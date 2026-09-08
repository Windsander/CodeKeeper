import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { PipelineRunStore } from '../../../../src/advance/pipeline/core/run-store.js';
import type { PipelineDefinition } from '../../../../src/advance/pipeline/core/types.js';

function makeStore(): { store: PipelineRunStore; db: Database.Database } {
  const db = new Database(':memory:');
  // 与 MetadataStore 共用同一份 schema 正本
  const schema = readFileSync(join(__dirname, '../../../../src/advance/store/schema.sql'), 'utf-8');
  db.exec(schema);
  return { store: new PipelineRunStore(db), db };
}

const definition: PipelineDefinition = {
  version: 1,
  id: 'p1',
  nodes: [{ id: 'a', type: 'test.node', params: {} }],
  edges: [],
};

describe('PipelineRunStore', () => {
  it('run 全生命周期：创建 -> 完成 -> 读取', () => {
    const { store } = makeStore();
    const runId = store.createRun('p1', definition, 'proj-1');
    store.finishRun(runId, 'succeeded');

    const record = store.getRun(runId);
    expect(record).not.toBeNull();
    expect(record!.pipelineId).toBe('p1');
    expect(record!.projectId).toBe('proj-1');
    expect(record!.status).toBe('succeeded');
    expect(record!.definition.id).toBe('p1');
    expect(record!.finishedAt).not.toBeNull();
  });

  it('stage 记录：begin -> succeed，输出可回读', () => {
    const { store } = makeStore();
    const runId = store.createRun('p1', definition);
    const stageId = store.beginStage(runId, 'a', { tick: 1 });
    store.finishStage(stageId, 'succeeded', { result: 'ok' });

    const stages = store.getStageRuns(runId);
    expect(stages).toHaveLength(1);
    expect(stages[0].status).toBe('succeeded');
    expect(stages[0].inputs).toEqual({ tick: 1 });
    expect(stages[0].outputs).toEqual({ result: 'ok' });
  });

  it('beginStage 幂等：同一 run+node 复用同一行并重置状态', () => {
    const { store } = makeStore();
    const runId = store.createRun('p1', definition);
    const first = store.beginStage(runId, 'a', {});
    store.finishStage(first, 'failed', undefined, 'boom');
    const second = store.beginStage(runId, 'a', { retry: true });
    expect(second).toBe(first);
    const stages = store.getStageRuns(runId);
    expect(stages).toHaveLength(1);
    expect(stages[0].status).toBe('running');
    expect(stages[0].error).toBeNull();
  });

  it('getSucceededOutputs 仅返回成功节点的产物', () => {
    const { store } = makeStore();
    const runId = store.createRun('p1', definition);
    const s1 = store.beginStage(runId, 'a', {});
    store.finishStage(s1, 'succeeded', { v: 1 });
    const s2 = store.beginStage(runId, 'b', {});
    store.finishStage(s2, 'failed', undefined, 'x');

    const outputs = store.getSucceededOutputs(runId);
    expect(outputs.get('a')).toEqual({ v: 1 });
    expect(outputs.has('b')).toBe(false);
  });

  it('listRuns 按项目/管线过滤', () => {
    const { store } = makeStore();
    store.createRun('p1', definition, 'proj-1');
    store.createRun('p2', { ...definition, id: 'p2' }, 'proj-1');
    expect(store.listRuns('p1')).toHaveLength(1);
    expect(store.listRuns()).toHaveLength(2);
  });
});
