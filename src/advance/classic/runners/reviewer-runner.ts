import type { ProjectConfig } from './role-runner.js';
import type { IRoleRunner } from './role-runner.js';

/**
 * Reviewer 角色的 Runner 实现
 * 当前为占位实现，后续 Task 10 将迁移实际 MR 评审逻辑
 */
export class ReviewerRunner implements IRoleRunner {
  async startProjectLoop(_project: ProjectConfig): Promise<void> {
    // 占位：后续迁移实际 reviewProject 逻辑
  }

  stopProjectLoop(_projectId: string): void {
    // 占位
  }
}
