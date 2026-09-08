import type { Role } from '../../types.js';
import { ReviewerRunner } from './reviewer-runner.js';
import { MaintainerRunner } from './maintainer-runner.js';
import { ArchiverRunner } from './archiver-runner.js';
import { LlmClient } from '../../llm/client.js';

/**
 * 项目配置（兼容类型，用于 Runner 接口）
 * 与 types.ts 中的 Project 类型保持一致
 */
export interface ProjectConfig {
  id: string;
  rootPath: string;
  name: string;
}

/**
 * 角色 Runner 统一接口
 * 每个角色实现此接口以提供项目级单次执行逻辑
 *
 * 调度由 daemon 侧 PipelineScheduler（管线 trigger.cron 节点）负责，
 * Runner 只响应"执行一次"。
 */
export interface IRoleRunner {
  /**
   * 执行指定项目的单次角色循环
   * @param project - 项目配置
   */
  runProjectOnce(project: ProjectConfig): Promise<void>;
}

export interface CreateRoleRunnerOptions {
  llmClient: LlmClient;
  mcpUrl?: string;
  codeGraphUrl?: string;
}

/**
 * 根据角色创建对应的 Runner 实例
 * @param role - 角色标识
 * @param options - Runner 构造选项
 * @returns 对应角色的 Runner 实例
 * @throws 当传入未支持的角色时抛出错误
 */
export function createRoleRunner(role: Role, options: CreateRoleRunnerOptions): IRoleRunner {
  switch (role) {
    case 'reviewer':
      return new ReviewerRunner({ llmClient: options.llmClient });
    case 'maintainer':
      return new MaintainerRunner({ llmClient: options.llmClient });
    case 'archiver':
      return new ArchiverRunner({
        llmClient: options.llmClient,
        mcpUrl: options.mcpUrl ?? process.env.CK_EVEROS_MCP_URL ?? '',
        codeGraphUrl: options.codeGraphUrl ?? process.env.CK_CODEGRAPH_SERVER_URL,
      });
    default:
      throw new Error(`未支持的角色: ${role}`);
  }
}
