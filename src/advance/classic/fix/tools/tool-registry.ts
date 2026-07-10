/**
 * 工具注册表
 *
 * 负责管理暴露给 LLM 的工具定义，支持按名称查找。
 */

import type { ToolDefinition } from '../../../llm/tool-types.js';
import { FIX_TOOLS } from './tool-definitions.js';

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[] = FIX_TOOLS) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: ToolDefinition): void {
    if (this.definitions.has(tool.name)) {
      console.warn(`[ToolRegistry] 工具 ${tool.name} 重复注册，将覆盖`);
    }
    this.definitions.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.definitions.values());
  }
}
