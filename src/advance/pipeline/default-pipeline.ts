/**
 * 默认管线生成与自动迁移。
 *
 * 老配置（项目 roles_config 中的角色开关与调度）在首次加载时自动生成
 * `.codekeeper/pipeline.yaml` 正本：每个启用角色 = trigger.cron 节点 → role.* 节点。
 * 生成后人类可直接编辑 YAML，画布编辑器读写同一文件。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { logger } from '../core/logger.js';
import { recordProjectError } from '../classic/status/project-status-store.js';
import type { Project, Role, RoleConfig } from '../types.js';
import { getRoleConfigSchedule, isRoleConfigEnabled, ROLES } from '../types.js';
import { PIPELINE_DEFINITION_RELATIVE_PATH, parsePipelineDefinition } from './core/loader.js';
import type { PipelineDefinition } from './core/types.js';

/** 角色默认调度（与旧版 Runner 内置调度一致） */
export const DEFAULT_ROLE_SCHEDULES: Record<Role, string> = {
  reviewer: '*/10 * * * *',
  maintainer: '*/10 * * * *',
  archiver: '0 2 * * *',
};

/**
 * 自动生成正本的首行标记。
 * 带标记的 pipeline.yaml 视为"配置投影"：角色配置更新时会被重新生成；
 * 用户编辑文件（删除标记）后即成为人类正本，配置更新不再触碰。
 */
export const GENERATED_PIPELINE_MARKER = '# codekeeper:generated';

/** 为项目生成默认管线定义（纯函数，便于测试） */
export function buildDefaultPipeline(project: Project): PipelineDefinition {
  const nodes: PipelineDefinition['nodes'] = [];
  const edges: PipelineDefinition['edges'] = [];

  for (const role of ROLES) {
    const config = project.roles?.[role] as RoleConfig | undefined;
    if (!isRoleConfigEnabled(config)) continue;

    const schedule = getRoleConfigSchedule(config)?.trim() || DEFAULT_ROLE_SCHEDULES[role];
    const triggerId = `trigger-${role}`;
    const roleNodeId = `role-${role}`;

    nodes.push({
      id: triggerId,
      type: 'trigger.cron',
      label: `${role} 定时触发`,
      params: { schedule },
    });
    nodes.push({
      id: roleNodeId,
      type: `role.${role}`,
      label: role,
      params: {},
    });
    edges.push({
      from: { node: triggerId, port: 'tick' },
      to: { node: roleNodeId, port: 'trigger' },
      channel: 'memory',
      artifactType: 'Tick',
    });

    // archiver 之后链知识投影：归档完成 → 正本 → EverOS 检索层
    if (role === 'archiver') {
      nodes.push({
        id: 'knowledge-project',
        type: 'knowledge.project',
        label: '知识投影',
        params: {},
      });
      edges.push({
        from: { node: roleNodeId, port: 'done' },
        to: { node: 'knowledge-project', port: 'in' },
        channel: 'memory',
        artifactType: 'ArchiveDone',
      });
    }
  }

  return {
    version: 1,
    id: `pipeline-${project.id}`,
    label: `${project.name} 默认管线`,
    nodes,
    edges,
  };
}

/** 项目的管线正本路径 */
export function getPipelineDefinitionPath(project: Project): string {
  return join(project.rootPath, PIPELINE_DEFINITION_RELATIVE_PATH);
}

/**
 * 确保项目存在管线正本：缺失时从角色配置生成默认 pipeline.yaml。
 * 返回管线正本路径；项目无启用角色时返回 null（不生成空管线）。
 */
export function ensurePipelineDefinition(project: Project): string | null {
  const filePath = getPipelineDefinitionPath(project);
  if (existsSync(filePath)) return filePath;

  const definition = buildDefaultPipeline(project);
  if (definition.nodes.length === 0) return null;

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, GENERATED_PIPELINE_MARKER + '\n' + stringify(definition), 'utf-8');
    logger.info(`项目 ${project.name} 已生成默认管线定义: ${filePath}`);
    return filePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`项目 ${project.name} 生成默认管线失败: ${message}`);
    return null;
  }
}

/**
 * 角色配置更新后同步管线正本：仅当现有文件仍带生成标记时重建
 * （人类编辑过的文件不再回写，调度以人类正本为准）。
 */
export function regeneratePipelineDefinitionIfGenerated(project: Project): void {
  const filePath = getPipelineDefinitionPath(project);
  if (!existsSync(filePath)) return;
  try {
    const head = readFileSync(filePath, 'utf-8').slice(0, 200);
    if (!head.startsWith(GENERATED_PIPELINE_MARKER)) return;
    const definition = buildDefaultPipeline(project);
    if (definition.nodes.length === 0) return;
    writeFileSync(filePath, GENERATED_PIPELINE_MARKER + '\n' + stringify(definition), 'utf-8');
    logger.info(`项目 ${project.name} 的生成管线已随角色配置更新: ${filePath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`项目 ${project.name} 重新生成管线定义失败: ${message}`);
  }
}

/** 读取并校验项目的管线定义；文件缺失返回 null，存在但非法时记录项目错误后返回 null。 */
export function loadProjectPipeline(project: Project): PipelineDefinition | null {
  const filePath = getPipelineDefinitionPath(project);
  if (!existsSync(filePath)) return null;
  try {
    return parsePipelineDefinition(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`项目 ${project.name} 管线定义解析失败: ${message}`);
    // 与非法 cron 同一上报口径：UI 项目状态可见
    recordProjectError(project, new Error(`管线定义解析失败: ${message}`), 'unknown');
    return null;
  }
}
