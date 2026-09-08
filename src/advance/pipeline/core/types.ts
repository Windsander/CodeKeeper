/**
 * 管线图核心类型与 Schema
 *
 * 管线定义的正本是项目内的 `.codekeeper/pipeline.yaml`（人类可读、可入库），
 * 画布编辑器与 daemon 均以本模块的 zod schema 为准进行校验。
 *
 * 分层模型：
 * - 画布层节点：trigger.* / role.* / agent.* / knowledge.* / sink.*
 * - 钻取层：NodeDef.subgraph 预留（M7），允许 Role 节点内展开 stage 子图
 * - 边 = 类型化端口引用 + channel 绑定（人类参与点如 gitlab-discussion 显式可见）
 */

import { z } from 'zod';

/** 端口引用：某节点的某个端口 */
export const portRefSchema = z.object({
  node: z.string().min(1),
  port: z.string().min(1),
});
export type PortRef = z.infer<typeof portRefSchema>;

/**
 * 边的传输通道绑定。
 * - memory：进程内直接传递（默认）
 * - queue：经 SQLite 队列异步传递
 * - gitlab-discussion：经 GitLab discussion（人类参与点）
 * - everos：经 EverOS 记忆
 * - fs：经文件系统
 * - a2a-task：经 A2A 任务（外部 Agent）
 */
export const edgeChannelSchema = z.enum([
  'memory',
  'queue',
  'gitlab-discussion',
  'everos',
  'fs',
  'a2a-task',
]);
export type EdgeChannel = z.infer<typeof edgeChannelSchema>;

export const edgeSchema = z.object({
  id: z.string().optional(),
  from: portRefSchema,
  to: portRefSchema,
  channel: edgeChannelSchema.default('memory'),
  /** 边上流动的产物类型（如 MRContext / Findings / KnowledgeItem），用于校验与展示 */
  artifactType: z.string().optional(),
});
export type EdgeDef = z.infer<typeof edgeSchema>;

export const nodeSchema = z.object({
  id: z.string().min(1),
  /** 节点类型，命名空间式：trigger.cron / role.reviewer / agent.a2a / knowledge.recall / sink.gitlab … */
  type: z.string().min(1),
  label: z.string().optional(),
  /**
   * 节点参数（角色配置、触发器 cron 表达式等），由节点处理器解释。
   * 注意：params 会随运行记录明文落库，凭据（token/apiKey）禁止写入 params
   * 或产物，只允许经 RunContext.services 注入。
   */
  params: z.record(z.unknown()).default({}),
  /** 画布坐标（可视化编辑器写回） */
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});
export type NodeDef = z.infer<typeof nodeSchema>;

export const pipelineDefinitionSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  label: z.string().optional(),
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(edgeSchema).default([]),
});
export type PipelineDefinition = z.infer<typeof pipelineDefinitionSchema>;

/**
 * 带钻取层预留的节点视图。
 * subgraph 在 schema 层面以宽松递归形式预留（M7 才由执行器解释）。
 * 递归部分用 ZodTypeAny 标注以避免 zod 输入/输出类型分裂，精度由下方手写类型提供。
 */
export const nodeWithSubgraphSchema = nodeSchema.extend({
  subgraph: z.lazy((): z.ZodTypeAny => pipelineWithSubgraphSchema).optional(),
});
export type NodeWithSubgraph = z.infer<typeof nodeSchema> & {
  subgraph?: PipelineDefinitionWithSubgraph;
};

export const pipelineWithSubgraphSchema = pipelineDefinitionSchema.extend({
  nodes: z.array(nodeWithSubgraphSchema).min(1),
});
export type PipelineDefinitionWithSubgraph = Omit<PipelineDefinition, 'nodes'> & {
  nodes: NodeWithSubgraph[];
};

/** 节点处理器：执行一个节点并产出输出端口产物 */
export interface NodeHandler {
  /** 处理的节点类型（与 NodeDef.type 对应） */
  readonly type: string;
  /** 声明的输入端口名（可选，用于校验边连接） */
  readonly inputs?: readonly string[];
  /** 声明的输出端口名（可选，用于校验边连接与产物类型） */
  readonly outputs?: readonly string[];
  run(
    ctx: RunContext,
    inputs: Record<string, unknown>,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown> | void>;
}

/** 节点执行上下文；服务（llm/memory/store 等）由 daemon 在装配时注入 services */
export interface RunContext {
  /** 结构化日志（与 core/logger 兼容的最小接口） */
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  /** 节点间取消信号 */
  signal?: AbortSignal;
  /** 装配期注入的服务表（llm、memory、gitProvider 等），M3 起由 daemon 填充 */
  services: Record<string, unknown>;
  /** 运行级变量（如 projectId、pipelineId、runId） */
  vars: Record<string, string>;
}

export class PipelineDefinitionError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = []
  ) {
    super(issues.length > 0 ? `${message}\n${issues.join('\n')}` : message);
    this.name = 'PipelineDefinitionError';
  }
}

export class PipelineCycleError extends Error {
  constructor(readonly cycleNodeIds: string[]) {
    super(`管线定义存在环，涉及节点: ${cycleNodeIds.join(', ')}`);
    this.name = 'PipelineCycleError';
  }
}
