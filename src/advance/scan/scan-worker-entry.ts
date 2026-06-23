/**
 * 归档扫描 Worker 子进程入口
 *
 * 由 ScanService 通过 child_process.fork 启动，在独立进程中执行：
 * 1. 全量文件扫描（scanExistingFiles）
 * 2. 归档流水线处理（ArchivePipeline.run）
 *
 * 通过 process.send / process.on('message') 与主进程通信。
 */

import { MetadataStore } from '../store/metadata-store.js';
import { ProjectRegistry } from '../project-registry.js';
import { ArchivePipeline } from '../pipeline/archive-pipeline.js';
import { LlmClient } from '../llm/client.js';
import { scanExistingFiles } from '../project-scanner.js';
import { loadProjectConfig } from '../config/project-config.js';
import type { Project } from '../types.js';

export interface ScanWorkerTask {
  /** 要扫描的项目列表 */
  projects: Project[];
  /** 数据库文件路径 */
  dbPath: string;
  /** LLM 配置 */
  daemonConfig: {
    apiKey: string;
    apiUrl: string;
    provider: 'anthropic' | 'openai';
    model: string;
    headers: Record<string, string>;
  };
  /** 每次扫描最多处理事件数 */
  maxEventsPerScan: number;
}

type ScanWorkerMessage =
  | { type: 'progress'; projectId: string; stage: 'scanning' | 'processing' }
  | { type: 'done' }
  | { type: 'error'; message: string };

function sendMessage(msg: ScanWorkerMessage): void {
  if (process.send) {
    process.send(msg);
  }
}

async function runScan(task: ScanWorkerTask): Promise<void> {
  console.log('[Scan Worker] 启动归档扫描任务');

  const store = new MetadataStore(task.dbPath);
  const registry = new ProjectRegistry({ store });

  // 重新注册传入的项目，确保子进程中的 registry 与主进程一致
  for (const project of task.projects) {
    registry.register(project.rootPath, project.archiveRoot);
  }

  const client = new LlmClient({
    apiKey: task.daemonConfig.apiKey,
    baseURL: task.daemonConfig.apiUrl,
    provider: task.daemonConfig.provider,
    model: task.daemonConfig.model,
    headers: task.daemonConfig.headers,
  });

  const pipeline = new ArchivePipeline({
    store,
    client,
    maxEvents: task.maxEventsPerScan,
  });

  try {
    for (const project of task.projects) {
      sendMessage({ type: 'progress', projectId: project.id, stage: 'scanning' });
      console.log(`[Scan Worker] 扫描项目: ${project.name}`);

      const config = loadProjectConfig(project.rootPath, project.archiveRoot);
      const addedCount = await scanExistingFiles(store, project, config);
      console.log(`[Scan Worker] 项目 ${project.name} 发现 ${addedCount} 个新文件`);

      sendMessage({ type: 'progress', projectId: project.id, stage: 'processing' });
      await pipeline.run(project);
      console.log(`[Scan Worker] 项目 ${project.name} 归档处理完成`);
    }

    sendMessage({ type: 'done' });
  } finally {
    store.close();
  }
}

process.on('message', (task: ScanWorkerTask) => {
  runScan(task).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Scan Worker] 扫描任务失败:', message);
    sendMessage({ type: 'error', message });
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  console.log('[Scan Worker] 收到 SIGTERM，退出');
  process.exit(0);
});
