import { createRoleRunner } from '../runners/role-runner.js';
import type { Role } from '../../types.js';

/**
 * 统一角色 Agent Entry
 * 根据 ROLE 环境变量选择对应的 Runner 并启动项目循环
 */
async function main() {
  const role = process.env.ROLE as Role;
  if (!role) {
    throw new Error('缺少 ROLE 环境变量');
  }

  const runner = createRoleRunner(role);

  // 从环境变量读取项目列表并启动循环
  const projectsJson = process.env.PROJECTS || '[]';
  const projects = JSON.parse(projectsJson);

  for (const project of projects) {
    await runner.startProjectLoop(project);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
