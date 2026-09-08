/**
 * 管线顺序执行器。
 *
 * v1 语义：
 * - 按拓扑序在进程内顺序执行节点；节点间产物经边（from.port -> to.port）传递
 * - 每个节点边界落库（PipelineRunStore），失败即停，可通过 resume 从最近成功点续跑
 * - channel 绑定当前仅作元数据记录；queue/gitlab-discussion/everos/a2a-task 等
 *   非 memory 通道的实体化在后续里程碑实现
 * - NodeDef.subgraph（钻取层）在 M7 才解释，当前忽略
 */

import type { NodeDef, NodeHandler, PipelineDefinition, RunContext } from './types.js';
import { PipelineDefinitionError } from './types.js';
import { topoSort, validateGraph } from './topology.js';
import type { PipelineRunRecord, PipelineRunStore } from './run-store.js';

export interface ExecuteOptions {
  /** 运行关联的项目 id（可选，写入 run 记录） */
  projectId?: string;
  /**
   * 只执行从给定节点出发可达的子 DAG（含起点本身）。
   * 用于多触发器管线：某个 trigger 触发时只运行其下游分支。
   * 缺省执行整张图。
   */
  startFrom?: string[];
}

export class PipelineExecutor {
  constructor(
    private readonly handlers: ReadonlyMap<string, NodeHandler>,
    private readonly store?: PipelineRunStore
  ) {}

  /** 从头执行一条管线；节点失败时运行标记为 failed 并返回（不抛异常）。 */
  async execute(
    definition: PipelineDefinition,
    ctx: RunContext,
    options: ExecuteOptions = {}
  ): Promise<PipelineRunRecord> {
    const ordered = this.prepare(definition, options.startFrom);
    const runId =
      this.store?.createRun(definition.id, definition, options.projectId) ?? 'ephemeral';
    ctx.vars = { ...ctx.vars, pipelineId: definition.id, runId };

    const status = await this.executeNodes(definition, ordered, ctx, runId, new Map(), new Set());
    if (!this.store) {
      return ephemeralRecord(runId, definition, status.error, options.projectId);
    }
    this.store.finishRun(
      runId,
      status.error ? (status.cancelled ? 'cancelled' : 'failed') : 'succeeded',
      status.error
    );
    const finished = this.store.getRun(runId);
    if (!finished) {
      throw new PipelineDefinitionError(`运行记录写入后不可读: ${runId}`);
    }
    return finished;
  }

  /**
   * 从最近成功节点续跑一个 failed/running 的 run。
   * 已成功节点不重跑，其落库产物继续供下游消费。
   * 注意：
   * - 续跑使用的是 run 创建时落库的定义快照，对 pipeline.yaml 的后续修改不影响进行中的 run；
   * - resume 按全图校验处理器，若原 run 是 startFrom 子图执行且其它分支处理器未注册，
   *   需由调用方保证注册表覆盖全图（当前调度器不使用 resume，预留给后续里程碑）。
   */
  async resume(runId: string, ctx: RunContext): Promise<PipelineRunRecord> {
    if (!this.store) {
      throw new PipelineDefinitionError('无 PipelineRunStore，无法 resume');
    }
    const record = this.store.getRun(runId);
    if (!record) {
      throw new PipelineDefinitionError(`运行记录不存在: ${runId}`);
    }
    if (record.status === 'succeeded') {
      return record;
    }

    const definition = record.definition;
    const ordered = this.prepare(definition);
    ctx.vars = { ...ctx.vars, pipelineId: definition.id, runId };

    const completedOutputs = this.store.getSucceededOutputs(runId);
    const status = await this.executeNodes(
      definition,
      ordered,
      ctx,
      runId,
      completedOutputs,
      new Set(completedOutputs.keys())
    );
    this.store.finishRun(
      runId,
      status.error ? (status.cancelled ? 'cancelled' : 'failed') : 'succeeded',
      status.error
    );
    const resumed = this.store.getRun(runId);
    if (!resumed) {
      throw new PipelineDefinitionError(`运行记录写入后不可读: ${runId}`);
    }
    return resumed;
  }

  /** 结构校验 + 处理器存在性/端口声明校验 + 拓扑排序（startFrom 时裁剪为下游子图） */
  private prepare(definition: PipelineDefinition, startFrom?: string[]): NodeDef[] {
    validateGraph(definition);
    // startFrom 时先裁剪：只校验并执行可达子图，允许图中存在本次不执行的、
    // 处理器未注册的其它分支（如多角色管线中别的角色分支）
    const ordered = topoSort(definition);
    const scoped = startFrom
      ? ordered.filter(node => collectReachable(definition, startFrom).has(node.id))
      : ordered;

    const issues: string[] = [];
    for (const node of scoped) {
      const handler = this.handlers.get(node.type);
      if (!handler) {
        issues.push(`节点 ${node.id} 的类型未注册处理器: ${node.type}`);
        continue;
      }
      if (handler.inputs || handler.outputs) {
        for (const edge of definition.edges) {
          if (
            edge.to.node === node.id &&
            handler.inputs &&
            !handler.inputs.includes(edge.to.port)
          ) {
            issues.push(`节点 ${node.id} 未声明输入端口: ${edge.to.port}`);
          }
          if (
            edge.from.node === node.id &&
            handler.outputs &&
            !handler.outputs.includes(edge.from.port)
          ) {
            issues.push(`节点 ${node.id} 未声明输出端口: ${edge.from.port}`);
          }
        }
      }
    }
    if (issues.length > 0) {
      throw new PipelineDefinitionError('管线处理器校验失败', issues);
    }
    return scoped;
  }

  private async executeNodes(
    definition: PipelineDefinition,
    ordered: NodeDef[],
    ctx: RunContext,
    runId: string,
    completedOutputs: Map<string, Record<string, unknown>>,
    skip: Set<string>
  ): Promise<{ error?: string; cancelled?: boolean }> {
    for (const node of ordered) {
      if (skip.has(node.id)) continue;
      if (ctx.signal?.aborted) {
        return { error: '运行被取消', cancelled: true };
      }

      const handler = this.handlers.get(node.type);
      if (!handler) {
        // prepare() 已校验，理论不可达；防御性处理
        return { error: `节点 ${node.id} 的类型未注册处理器: ${node.type}` };
      }
      const inputs = this.gatherInputs(definition, node.id, completedOutputs);
      const stageId = this.store?.beginStage(runId, node.id, inputs);

      try {
        const outputs = (await handler.run(ctx, inputs, node.params, node)) ?? {};
        completedOutputs.set(node.id, outputs);
        if (this.store && stageId) {
          this.store.finishStage(stageId, 'succeeded', outputs);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.store && stageId) {
          this.store.finishStage(stageId, 'failed', undefined, message);
        }
        ctx.logger.error(`节点 ${node.id} 执行失败: ${message}`);
        return { error: `节点 ${node.id} 执行失败: ${message}` };
      }
    }
    return {};
  }

  /** 汇聚某节点的全部入边产物：inputs[to.port] = 上游 outputs[from.port] */
  private gatherInputs(
    definition: PipelineDefinition,
    nodeId: string,
    completedOutputs: Map<string, Record<string, unknown>>
  ): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};
    for (const edge of definition.edges) {
      if (edge.to.node !== nodeId) continue;
      const upstream = completedOutputs.get(edge.from.node);
      if (upstream && edge.from.port in upstream) {
        inputs[edge.to.port] = upstream[edge.from.port];
      }
    }
    return inputs;
  }
}

/** 收集从起点集合出发可达的全部节点 id（含起点）；起点不存在时抛错。 */
function collectReachable(definition: PipelineDefinition, startFrom: string[]): Set<string> {
  const known = new Set(definition.nodes.map(node => node.id));
  const downstream = new Map<string, string[]>();
  for (const edge of definition.edges) {
    downstream.set(edge.from.node, [...(downstream.get(edge.from.node) ?? []), edge.to.node]);
  }

  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const id of startFrom) {
    if (!known.has(id)) {
      throw new PipelineDefinitionError(`startFrom 起点节点不存在: ${id}`);
    }
    queue.push(id);
  }
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);
    queue.push(...(downstream.get(id) ?? []));
  }
  return reachable;
}

/** 无 store 时的临时运行记录（不持久化，仅返回执行结果） */
function ephemeralRecord(
  runId: string,
  definition: PipelineDefinition,
  error: string | undefined,
  projectId?: string
): PipelineRunRecord {
  const now = Date.now();
  return {
    id: runId,
    pipelineId: definition.id,
    projectId: projectId ?? null,
    status: error ? 'failed' : 'succeeded',
    definition,
    error: error ?? null,
    createdAt: now,
    finishedAt: now,
  };
}
