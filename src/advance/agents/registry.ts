/**
 * 外部 Agent 注册表（推广自 Archiver Provider 注册表模式）。
 *
 * Agent 规格来源：daemon-config.json 的 agents 数组（应用级配置）。
 * 管线 agent.* 节点经 params.agentId 引用注册表中的 Agent；
 * 节点也可内联连接参数（不注册的一次性对接），注册表提供健康探测与解析。
 */

import { z } from 'zod';
import { logger } from '../core/logger.js';
import type { AgentCapabilityCard } from './task-envelope.js';
import {
  A2aTransport,
  McpTransport,
  SubprocessTransport,
  type AgentTransport,
} from './transports.js';

/** Agent 注册规格（daemon-config.json 的 agents 数组元素） */
export const agentSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  transport: z.enum(['a2a', 'subprocess', 'mcp']),
  /** a2a：对端 base URL */
  endpoint: z.string().optional(),
  /** subprocess：可执行命令与参数 */
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** mcp：MCP server URL 与工具名 */
  serverUrl: z.string().optional(),
  tool: z.string().optional(),
});
export type AgentSpec = z.infer<typeof agentSpecSchema>;

export class AgentRegistry {
  private readonly specs = new Map<string, AgentSpec>();

  constructor(specs: AgentSpec[] = []) {
    for (const spec of specs) this.register(spec);
  }

  register(spec: AgentSpec): void {
    this.specs.set(spec.id, spec);
  }

  get(agentId: string): AgentSpec | undefined {
    return this.specs.get(agentId);
  }

  list(): AgentSpec[] {
    return [...this.specs.values()];
  }

  /**
   * 解析传输实例。
   * - params.agentId 引用注册项时，**注册项优先**（pipeline.yaml 是可入库正本，
   *   不允许项目内定义覆盖本机 daemon-config 中的连接参数，否则 clone 即投毒）；
   * - 内联 params 一次性对接仅允许网络类传输（a2a/mcp）；
   *   agent.subprocess 强制要求 agentId（可执行命令只能来自本机白名单）。
   */
  resolveTransport(nodeType: string, params: Record<string, unknown>): AgentTransport {
    const agentId = typeof params.agentId === 'string' ? params.agentId : undefined;
    const spec = agentId ? this.specs.get(agentId) : undefined;
    if (agentId && !spec) {
      throw new Error(`未注册的外部 Agent: ${agentId}`);
    }
    if (!spec && nodeType === 'agent.subprocess') {
      throw new Error(
        'agent.subprocess 节点必须引用已注册 Agent（params.agentId）；命令只允许来自本机 daemon-config 白名单'
      );
    }
    // 注册项优先于节点内联参数
    const merged = { ...params, ...spec } as AgentSpec & Record<string, unknown>;

    switch (nodeType) {
      case 'agent.subprocess': {
        const command = merged.command;
        if (typeof command !== 'string' || !command) {
          throw new Error('agent.subprocess 节点缺少 params.command');
        }
        return new SubprocessTransport({ command, args: asStringArray(merged.args) });
      }
      case 'agent.a2a': {
        const endpoint = merged.endpoint;
        if (typeof endpoint !== 'string' || !endpoint) {
          throw new Error('agent.a2a 节点缺少 params.endpoint');
        }
        return new A2aTransport({ endpoint });
      }
      case 'agent.mcp': {
        const { serverUrl, tool } = merged;
        if (typeof serverUrl !== 'string' || !serverUrl || typeof tool !== 'string' || !tool) {
          throw new Error('agent.mcp 节点缺少 params.serverUrl / params.tool');
        }
        return new McpTransport({ serverUrl, tool });
      }
      default:
        throw new Error(`未知 agent 节点类型: ${nodeType}`);
    }
  }

  /** 健康探测：返回每个注册 Agent 的可达性 */
  async probeAll(): Promise<Array<{ id: string; ok: boolean }>> {
    const results: Array<{ id: string; ok: boolean }> = [];
    for (const spec of this.specs.values()) {
      let ok = false;
      try {
        const transport = this.resolveTransport(`agent.${spec.transport}`, {
          agentId: spec.id,
        });
        ok = await transport.probe();
      } catch (error) {
        logger.warn({ err: error, agentId: spec.id }, '外部 Agent 探测失败');
      }
      results.push({ id: spec.id, ok });
    }
    return results;
  }

  /** 能力卡片列表（A2A 对端尝试实时拉取，失败回退注册信息） */
  async listCards(): Promise<AgentCapabilityCard[]> {
    const cards: AgentCapabilityCard[] = [];
    for (const spec of this.specs.values()) {
      if (spec.transport === 'a2a' && spec.endpoint) {
        const card = await new A2aTransport({ endpoint: spec.endpoint }).fetchCard();
        cards.push(card ?? specToCard(spec));
      } else {
        cards.push(specToCard(spec));
      }
    }
    return cards;
  }
}

function specToCard(spec: AgentSpec): AgentCapabilityCard {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    capabilities: spec.capabilities,
    transport: spec.transport,
  };
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : undefined;
}
