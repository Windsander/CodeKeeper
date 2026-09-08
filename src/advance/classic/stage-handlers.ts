/**
 * 角色子图的 stage 处理器（M7 钻取层，role-entry 子进程侧）。
 *
 * - stage.role-run：复合 stage，包装既有 Runner 的完整单次循环（黑箱不变）
 * - stage.ast-grep：ast-grep 预检（advisory），对 params.paths 指定的文件扫描
 *
 * Role 节点带 subgraph 时，role-entry 用本注册表执行子图而非整轮 runProjectOnce；
 * 默认子图（画布"展开为子图"生成）只含单个 stage.role-run，行为与黑箱完全一致。
 */

import { isAbsolute, join } from 'node:path';
import type { NodeHandler } from '../pipeline/core/types.js';
import type { Project } from '../types.js';
import type { IRoleRunner } from './runners/role-runner.js';
import { runAstGrepPrecheck } from '../ast-grep/runner.js';

export interface StageHandlerDeps {
  project: Project;
  runner: IRoleRunner;
}

export function createRoleStageHandlers(deps: StageHandlerDeps): Map<string, NodeHandler> {
  const handlers = new Map<string, NodeHandler>();

  handlers.set('stage.role-run', {
    type: 'stage.role-run',
    run: async () => {
      await deps.runner.runProjectOnce(deps.project);
      return { done: true };
    },
  });

  handlers.set('stage.ast-grep', {
    type: 'stage.ast-grep',
    run: async (_ctx, _inputs, params) => {
      // 相对路径按项目根归一（子进程 CWD 继承自 daemon，不可依赖）
      const paths = Array.isArray(params.paths)
        ? params.paths
            .filter((p): p is string => typeof p === 'string')
            .map(p => (isAbsolute(p) ? p : join(deps.project.rootPath, p)))
        : [];
      const configPath =
        typeof params.config === 'string'
          ? params.config
          : join(deps.project.rootPath, '.codekeeper', 'sgconfig.yml');
      const result = await runAstGrepPrecheck(configPath, paths);
      return { precheck: result, findingsCount: result.findings.length };
    },
  });

  return handlers;
}
