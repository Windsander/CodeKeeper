import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BaseRoleRunner } from './base-role-runner.js';
import { ArchiverBrain } from '../archive/archiver-brain.js';
import { ArchiverActor } from '../archive/archiver-actor.js';
import { MemoryClient } from '../memory/memory-client.js';
import type { Project, RoleConfig } from '../../types.js';
import type { LlmClient } from '../../llm/client.js';

export interface ArchiverRunnerOptions {
  /** LLM 客户端实例 */
  llmClient: LlmClient;
  /** MCP Server URL */
  mcpUrl: string;
}

/**
 * 构建 Archiver 会话 ID（按 8 小时窗口粒度）
 */
export function buildArchiverSessionId(projectId: string, date: Date): string {
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const slot = Math.floor(date.getUTCHours() / 8);
  return `archiver-${projectId}-${yyyy}-${mm}-${dd}-${slot}`;
}

/**
 * Archiver 角色的 Runner 实现
 * 负责扫描项目文件、提炼知识、写入 EverOS
 */
export class ArchiverRunner extends BaseRoleRunner {
  private readonly mcpUrl: string;

  constructor(options: ArchiverRunnerOptions) {
    super({ llmClient: options.llmClient });
    this.mcpUrl = options.mcpUrl;
  }

  protected getRole(): 'archiver' {
    return 'archiver';
  }

  protected getDefaultSchedule(): string {
    return '0 2 * * *';
  }

  /**
   * Archiver 不需要 GitLab 配置，只要本地项目目录存在即可
   */
  protected validatePrerequisites(project: Project): boolean {
    const config = this.getRoleConfig(project);
    if (!config?.enabled) {
      console.log(`[ArchiverRunner] 项目 ${project.name} 未启用，跳过`);
      return false;
    }

    // 父类要求 gitlab，但 archiver 仅依赖本地目录
    return true;
  }

  protected async runProject(project: Project, _config: RoleConfig): Promise<void> {
    console.log(`[ArchiverRunner] 扫描项目 ${project.name}`);

    const files = await this.listProjectFiles(project.rootPath);
    if (files.length === 0) {
      console.log(`[ArchiverRunner] 项目 ${project.name} 无文件，跳过`);
      return;
    }

    const memoryClient = new MemoryClient({
      mcpUrl: this.mcpUrl,
      context: {
        appId: 'codekeeper-advance',
        projectId: project.id,
        agentId: 'archiver',
        userId: 'codekeeper-system',
        sessionId: buildArchiverSessionId(project.id, new Date()),
      },
    });
    await memoryClient.connect().catch(() => {
      console.warn('[ArchiverRunner] MemoryClient 连接失败，本次以无记忆模式运行');
    });

    const brain = new ArchiverBrain({ llmClient: this.llmClient });
    const actor = new ArchiverActor({ memoryClient });

    const items = await brain.analyzeProject(project, files);
    console.log(`[ArchiverRunner] 提炼出 ${items.length} 条项目知识`);

    await actor.storeKnowledge(items);

    await memoryClient.disconnect().catch(() => undefined);
  }

  private async listProjectFiles(rootPath: string, subPath = ''): Promise<string[]> {
    const dir = join(rootPath, subPath);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      const relativePath = subPath ? `${subPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (['node_modules', '.git', '.codekeeper', 'dist'].includes(entry.name)) continue;
        files.push(...(await this.listProjectFiles(rootPath, relativePath)));
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
    return files;
  }
}
