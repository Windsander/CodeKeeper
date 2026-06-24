import type { ProjectConfig } from './role-runner.js';
import type { IRoleRunner } from './role-runner.js';

/**
 * Maintainer 角色的 Runner 实现
 * 当前为占位实现，后续 Task 10 将迁移实际 auto-fix 逻辑
 */
export class MaintainerRunner implements IRoleRunner {
  async startProjectLoop(_project: ProjectConfig): Promise<void> {
    // 占位：后续迁移实际 auto-fix 逻辑
  }

  stopProjectLoop(_projectId: string): void {
    // 占位
  }
}
