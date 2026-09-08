/**
 * 外部 Agent 任务信封契约（A2A 词汇）。
 *
 * 管线 agent.* 节点与外部 Agent 的交互统一为：
 * 能力描述（AgentCapabilityCard）+ 任务信封（TaskEnvelope）+ 结果（TaskResult）。
 * 传输层（A2A HTTP / 本地子进程 / MCP 工具）是可插拔适配器，契约保持一致，
 * 未来接入完整 A2A 协议时只需替换 transport 实现。
 */

/** 结构化产物（A2A Artifact 的最小形态） */
export interface AgentArtifact {
  /** 产物名（对应管线端口名） */
  name: string;
  /** 产物类型（如 MRContext / Findings / Patch / KnowledgeItem） */
  type: string;
  /** 文本载荷（二进制产物先不支撑，后续以引用/URI 扩展） */
  content: string;
}

/** 任务信封（A2A Task 的最小形态） */
export interface TaskEnvelope {
  /** 任务 id（管线 runId:nodeId 派生） */
  id: string;
  /** 能力标识（如 code-review / security-scan），供对端路由 */
  capability: string;
  /** 管线端口产物（原始结构） */
  input: Record<string, unknown>;
  /** 结构化产物清单（input 的展平视图，便于非 JSON 对端消费） */
  artifacts: AgentArtifact[];
  /** 超时（毫秒），缺省由传输层决定 */
  timeoutMs?: number;
}

/** 任务结果（A2A Task 终态的最小形态） */
export interface TaskResult {
  status: 'completed' | 'failed';
  /**
   * 返回给管线的端口产物：键名必须与下游边的 from.port 一致才会被递送，
   * 写错的键会被静默丢弃（executor.gatherInputs 按边定义取值）。
   */
  output: Record<string, unknown>;
  artifacts: AgentArtifact[];
  error?: string;
}

/**
 * Agent 能力描述（A2A AgentCard 的最小子集）。
 * params 中的连接信息（endpoint/command/serverUrl）不属于卡片语义，由注册表另行持有。
 */
export interface AgentCapabilityCard {
  id: string;
  name: string;
  description?: string;
  /** 声明的能力标识列表（对应 TaskEnvelope.capability） */
  capabilities: string[];
  transport: 'a2a' | 'subprocess' | 'mcp';
}
