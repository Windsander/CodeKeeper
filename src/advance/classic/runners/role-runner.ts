import type { Role } from '../../types.js';
import { ReviewerRunner } from './reviewer-runner.js';
import { MaintainerRunner } from './maintainer-runner.js';
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
 * 每个角色实现此接口以提供项目级循环逻辑
 */
export interface IRoleRunner {
  /**
   * 启动指定项目的角色循环
   * @param project - 项目配置
   */
  startProjectLoop(project: ProjectConfig): Promise<void>;

  /**
   * 停止指定项目的角色循环
   * @param projectId - 项目唯一标识
   */
  stopProjectLoop(projectId: string): void;
}

/**
 * 根据角色创建对应的 Runner 实例
 * @param role - 角色标识
 * @param llmClient - LLM 客户端实例
 * @returns 对应角色的 Runner 实例
 * @throws 当传入未支持的角色时抛出错误
 */
export function createRoleRunner(role: Role, llmClient: LlmClient): IRoleRunner {
  switch (role) {
    case 'reviewer':
      return new ReviewerRunner({ llmClient });
    case 'maintainer':
      return new MaintainerRunner({ llmClient });
    default:
      throw new Error(`未支持的角色: ${role}`);
  }
}
