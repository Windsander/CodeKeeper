import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { PipelineExecutor } from '../../../../src/advance/pipeline/core/executor.js';
import { PipelineRunStore } from '../../../../src/advance/pipeline/core/run-store.js';
import type {
  NodeHandler,
  PipelineDefinition,
  RunContext,
} from '../../../../src/advance/pipeline/core/types.js';

function makeCtx(): RunContext {
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, services: {}, vars: {} };
}

function makeStore(): PipelineRunStore {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../../src/advance/store/schema.sql'), 'utf-8'));
  return new PipelineRunStore(db);
}

function handler(type: string, run: NodeHandler['run']): [string, NodeHandler] {
  return [type, { type, run }];
}

describe('PipelineExecutor 子图（钻取层）', () => {
  it('无处理器的节点带 subgraph 时递归执行子图，stage 记录带层级前缀', async () => {
    const calls: string[] = [];
    const handlers = new Map<string, NodeHandler>([
      handler('stage.a', async () => {
        calls.push('a');
        return { mid: 1 };
      }),
      handler('stage.b', async (_ctx, inputs) => {
        calls.push('b');
        return { final: (inputs.mid as number) + 1 };
      }),
    ]);
    const def = {
      version: 1,
      id: 'p',
      nodes: [
        { id: 'trigger', type: 'stage.a', params: {} },
        {
          id: 'composite',
          type: 'role.reviewer', // 未注册处理器 → 走子图
          params: {},
          subgraph: {
            version: 1,
            id: 'composite-sub',
            nodes: [
              { id: 's1', type: 'stage.a', params: {} },
              { id: 's2', type: 'stage.b', params: {} },
            ],
            edges: [
              {
                from: { node: 's1', port: 'mid' },
                to: { node: 's2', port: 'mid' },
                channel: 'memory' as const,
              },
            ],
          },
        },
      ],
      edges: [
        {
          from: { node: 'trigger', port: 'mid' },
          to: { node: 'composite', port: 'in' },
          channel: 'memory' as const,
        },
      ],
    } as unknown as PipelineDefinition;

    const store = makeStore();
    const record = await new PipelineExecutor(handlers, store).execute(def, makeCtx());

    expect(record.status).toBe('succeeded');
    const stageIds = store.getStageRuns(record.id).map(s => s.nodeId);
    expect(stageIds).toContain('composite/s1');
    expect(stageIds).toContain('composite/s2');
    // 终态节点输出汇聚为父节点产物
    const composite = store.getStageRuns(record.id).find(s => s.nodeId === 'composite');
    expect(composite?.outputs).toEqual({ final: 2 });
  });

  it('子图入口节点继承父节点输入', async () => {
    let received: Record<string, unknown> = {};
    const handlers = new Map<string, NodeHandler>([
      handler('stage.capture', async (_ctx, inputs) => {
        received = inputs;
        return {};
      }),
      handler('stage.src', async () => ({ external: 'x' })),
    ]);
    const def = {
      version: 1,
      id: 'p',
      nodes: [
        { id: 'src', type: 'stage.src', params: {} },
        {
          id: 'composite',
          type: 'role.maintainer',
          params: {},
          subgraph: {
            version: 1,
            id: 'sub',
            nodes: [{ id: 'entry', type: 'stage.capture', params: {} }],
            edges: [],
          },
        },
      ],
      edges: [
        {
          from: { node: 'src', port: 'external' },
          to: { node: 'composite', port: 'external' },
          channel: 'memory' as const,
        },
      ],
    } as unknown as PipelineDefinition;

    const record = await new PipelineExecutor(handlers, makeStore()).execute(def, makeCtx());
    expect(record.status).toBe('succeeded');
    expect(received.external).toBe('x');
  });

  it('子图内未注册 stage 类型导致父节点失败', async () => {
    const def = {
      version: 1,
      id: 'p',
      nodes: [
        {
          id: 'composite',
          type: 'role.archiver',
          params: {},
          subgraph: {
            version: 1,
            id: 'sub',
            nodes: [{ id: 's1', type: 'stage.ghost', params: {} }],
            edges: [],
          },
        },
      ],
      edges: [],
    } as unknown as PipelineDefinition;

    const record = await new PipelineExecutor(new Map(), makeStore()).execute(def, makeCtx());
    expect(record.status).toBe('failed');
    expect(record.error).toContain('stage.ghost');
  });

  it('子图运行记录按 projectId 可查（D1 回归：画布运行状态叠加的数据源）', async () => {
    const handlers = new Map<string, NodeHandler>([handler('stage.a', async () => ({ ok: true }))]);
    const def = {
      version: 1,
      id: 'p',
      nodes: [
        {
          id: 'composite',
          type: 'role.reviewer',
          params: {},
          subgraph: {
            version: 1,
            id: 'sub',
            nodes: [{ id: 's1', type: 'stage.a', params: {} }],
            edges: [],
          },
        },
      ],
      edges: [],
    } as unknown as PipelineDefinition;

    const store = makeStore();
    const record = await new PipelineExecutor(handlers, store).execute(def, makeCtx(), {
      projectId: 'proj-x',
    });
    expect(record.status).toBe('succeeded');
    // 按项目可查（listRunsByProject 是画布的数据源）
    const runs = store.listRunsByProject('proj-x');
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(record.id);
    // 子图 stage 记录随父 run 可查
    const stages = store.getStageRuns(record.id);
    expect(stages.map(s => s.nodeId)).toContain('composite/s1');

    // 含子图的 run 显式拒绝 resume（跳过集失配防护；先造一个失败的含子图 run）
    const failHandlers = new Map<string, NodeHandler>([
      handler('stage.a', async () => {
        throw new Error('炸了');
      }),
    ]);
    const failed = await new PipelineExecutor(failHandlers, store).execute(def, makeCtx(), {
      projectId: 'proj-x',
    });
    expect(failed.status).toBe('failed');
    await expect(
      new PipelineExecutor(handlers, store).resume(failed.id, makeCtx())
    ).rejects.toThrow(/子图/);
  });
});
