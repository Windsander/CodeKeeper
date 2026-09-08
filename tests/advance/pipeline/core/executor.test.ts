import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { PipelineExecutor } from '../../../../src/advance/pipeline/core/executor.js';
import { PipelineRunStore } from '../../../../src/advance/pipeline/core/run-store.js';
import {
  PipelineCycleError,
  PipelineDefinitionError,
  type NodeHandler,
  type PipelineDefinition,
  type RunContext,
} from '../../../../src/advance/pipeline/core/types.js';

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    services: {},
    vars: {},
    ...overrides,
  };
}

function makeStore(): PipelineRunStore {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../../src/advance/store/schema.sql'), 'utf-8'));
  return new PipelineRunStore(db);
}

function handler(
  type: string,
  run: NodeHandler['run'],
  ports: { inputs?: string[]; outputs?: string[] } = {}
): [string, NodeHandler] {
  return [type, { type, inputs: ports.inputs, outputs: ports.outputs, run }];
}

describe('PipelineExecutor', () => {
  it('按拓扑序执行并在节点间传递产物', async () => {
    const calls: string[] = [];
    const handlers = new Map<string, NodeHandler>([
      handler('source', async () => {
        calls.push('source');
        return { value: 41 };
      }),
      handler('incr', async (_ctx, inputs) => {
        calls.push('incr');
        return { value: (inputs.in as number) + 1 };
      }),
    ]);
    const def: PipelineDefinition = {
      version: 1,
      id: 'p',
      nodes: [
        { id: 'a', type: 'source', params: {} },
        { id: 'b', type: 'incr', params: {} },
      ],
      edges: [
        {
          from: { node: 'a', port: 'value' },
          to: { node: 'b', port: 'in' },
          channel: 'memory',
        },
      ],
    };

    const store = makeStore();
    const record = await new PipelineExecutor(handlers, store).execute(def, makeCtx());

    expect(calls).toEqual(['source', 'incr']);
    expect(record.status).toBe('succeeded');
    const stages = store.getStageRuns(record.id);
    expect(stages.map(s => s.status)).toEqual(['succeeded', 'succeeded']);
    expect(stages[1].inputs).toEqual({ in: 41 });
    expect(stages[1].outputs).toEqual({ value: 42 });
  });

  it('节点失败：运行标记 failed，后续节点不执行', async () => {
    const calls: string[] = [];
    const handlers = new Map<string, NodeHandler>([
      handler('ok', async () => {
        calls.push('ok');
      }),
      handler('boom', async () => {
        calls.push('boom');
        throw new Error('炸了');
      }),
      handler('never', async () => {
        calls.push('never');
      }),
    ]);
    const def: PipelineDefinition = {
      version: 1,
      id: 'p',
      nodes: [
        { id: 'a', type: 'ok', params: {} },
        { id: 'b', type: 'boom', params: {} },
        { id: 'c', type: 'never', params: {} },
      ],
      edges: [
        { from: { node: 'a', port: 'o' }, to: { node: 'b', port: 'i' }, channel: 'memory' },
        { from: { node: 'b', port: 'o' }, to: { node: 'c', port: 'i' }, channel: 'memory' },
      ],
    };

    const store = makeStore();
    const record = await new PipelineExecutor(handlers, store).execute(def, makeCtx());

    expect(calls).toEqual(['ok', 'boom']);
    expect(record.status).toBe('failed');
    expect(record.error).toContain('炸了');
    const stages = store.getStageRuns(record.id);
    expect(stages.map(s => [s.nodeId, s.status])).toEqual([
      ['a', 'succeeded'],
      ['b', 'failed'],
    ]);
  });

  it('resume 跳过已成功节点，从失败点续跑', async () => {
    const calls: string[] = [];
    let failFirst = true;
    const handlers = new Map<string, NodeHandler>([
      handler('ok', async () => {
        calls.push('ok');
        return { v: 1 };
      }),
      handler('flaky', async (_ctx, inputs) => {
        calls.push('flaky');
        if (failFirst) throw new Error('第一次失败');
        return { v: (inputs.in as number) + 1 };
      }),
    ]);
    const def: PipelineDefinition = {
      version: 1,
      id: 'p',
      nodes: [
        { id: 'a', type: 'ok', params: {} },
        { id: 'b', type: 'flaky', params: {} },
      ],
      edges: [{ from: { node: 'a', port: 'v' }, to: { node: 'b', port: 'in' }, channel: 'memory' }],
    };

    const store = makeStore();
    const executor = new PipelineExecutor(handlers, store);
    const first = await executor.execute(def, makeCtx());
    expect(first.status).toBe('failed');

    failFirst = false;
    calls.length = 0;
    const second = await executor.resume(first.id, makeCtx());

    expect(second.status).toBe('succeeded');
    // ok 节点未重跑，flaky 拿到了 ok 首次运行的落库产物
    expect(calls).toEqual(['flaky']);
    const stages = store.getStageRuns(first.id);
    const flakyStage = stages.find(s => s.nodeId === 'b')!;
    expect(flakyStage.status).toBe('succeeded');
    expect(flakyStage.outputs).toEqual({ v: 2 });
    expect(flakyStage.inputs).toEqual({ in: 1 });
  });

  it('未注册处理器的节点类型在执行前报错', async () => {
    const def: PipelineDefinition = {
      version: 1,
      id: 'p',
      nodes: [{ id: 'a', type: 'ghost.type', params: {} }],
      edges: [],
    };
    await expect(
      new PipelineExecutor(new Map(), makeStore()).execute(def, makeCtx())
    ).rejects.toThrow(PipelineDefinitionError);
  });

  it('边连接到未声明端口时报错', async () => {
    const handlers = new Map<string, NodeHandler>([
      handler('typed', async () => ({}), { inputs: ['in'], outputs: ['out'] }),
    ]);
    const def: PipelineDefinition = {
      version: 1,
      id: 'p',
      nodes: [
        { id: 'a', type: 'typed', params: {} },
        { id: 'b', type: 'typed', params: {} },
      ],
      edges: [
        { from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'wrong' }, channel: 'memory' },
      ],
    };
    await expect(
      new PipelineExecutor(handlers, makeStore()).execute(def, makeCtx())
    ).rejects.toThrow(/wrong/);
  });

  it('环定义在执行前抛出 PipelineCycleError', async () => {
    const handlers = new Map<string, NodeHandler>([handler('n', async () => ({}))]);
    const def: PipelineDefinition = {
      version: 1,
      id: 'p',
      nodes: [
        { id: 'a', type: 'n', params: {} },
        { id: 'b', type: 'n', params: {} },
      ],
      edges: [
        { from: { node: 'a', port: 'o' }, to: { node: 'b', port: 'i' }, channel: 'memory' },
        { from: { node: 'b', port: 'o' }, to: { node: 'a', port: 'i' }, channel: 'memory' },
      ],
    };
    await expect(
      new PipelineExecutor(handlers, makeStore()).execute(def, makeCtx())
    ).rejects.toThrow(PipelineCycleError);
  });

  it('无 store 时以 ephemeral 模式返回结果', async () => {
    const handlers = new Map<string, NodeHandler>([handler('n', async () => ({ v: 1 }))]);
    const def: PipelineDefinition = {
      version: 1,
      id: 'p',
      nodes: [{ id: 'a', type: 'n', params: {} }],
      edges: [],
    };
    const record = await new PipelineExecutor(handlers).execute(def, makeCtx());
    expect(record.status).toBe('succeeded');
    expect(record.id).toBe('ephemeral');
  });

  it('startFrom 只执行起点下游子图', async () => {
    const calls: string[] = [];
    const handlers = new Map<string, NodeHandler>([
      handler('n', async (_ctx, _inputs, params) => {
        calls.push(String(params.name));
        return {};
      }),
    ]);
    // t1 -> a；t2 -> b：从 t1 触发不应执行 t2/b
    const def: PipelineDefinition = {
      version: 1,
      id: 'p',
      nodes: [
        { id: 't1', type: 'n', params: { name: 't1' } },
        { id: 'a', type: 'n', params: { name: 'a' } },
        { id: 't2', type: 'n', params: { name: 't2' } },
        { id: 'b', type: 'n', params: { name: 'b' } },
      ],
      edges: [
        { from: { node: 't1', port: 'o' }, to: { node: 'a', port: 'i' }, channel: 'memory' },
        { from: { node: 't2', port: 'o' }, to: { node: 'b', port: 'i' }, channel: 'memory' },
      ],
    };

    const record = await new PipelineExecutor(handlers, makeStore()).execute(def, makeCtx(), {
      startFrom: ['t1'],
    });
    expect(record.status).toBe('succeeded');
    expect(calls).toEqual(['t1', 'a']);
  });

  it('startFrom 起点不存在时报错', async () => {
    const handlers = new Map<string, NodeHandler>([handler('n', async () => ({}))]);
    const def: PipelineDefinition = {
      version: 1,
      id: 'p',
      nodes: [{ id: 'a', type: 'n', params: {} }],
      edges: [],
    };
    await expect(
      new PipelineExecutor(handlers, makeStore()).execute(def, makeCtx(), { startFrom: ['ghost'] })
    ).rejects.toThrow(/ghost/);
  });

  it('abort signal 在节点间生效', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const handlers = new Map<string, NodeHandler>([
      handler('first', async () => {
        calls.push('first');
        controller.abort();
      }),
      handler('second', async () => {
        calls.push('second');
      }),
    ]);
    const def: PipelineDefinition = {
      version: 1,
      id: 'p',
      nodes: [
        { id: 'a', type: 'first', params: {} },
        { id: 'b', type: 'second', params: {} },
      ],
      edges: [{ from: { node: 'a', port: 'o' }, to: { node: 'b', port: 'i' }, channel: 'memory' }],
    };
    const record = await new PipelineExecutor(handlers, makeStore()).execute(
      def,
      makeCtx({ signal: controller.signal })
    );
    expect(calls).toEqual(['first']);
    expect(record.status).toBe('cancelled');
  });
});
