import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MetadataStore } from './store/metadata-store';
import { ProjectRegistry, makeProjectId } from './project-registry';
import { Daemon } from './daemon';
import { LlmClient } from './llm/client';
import { ArchivePipeline } from './pipeline/archive-pipeline';
import { UndoExecutor } from './archive/undo-executor';
import { loadDaemonConfig } from './config/daemon-config';

const DATA_DIR = join(homedir(), '.codekeeper-advance');
const DB_PATH = join(DATA_DIR, 'metadata.db');

function getDeps() {
  mkdirSync(DATA_DIR, { recursive: true });
  const store = new MetadataStore(DB_PATH);
  const registry = new ProjectRegistry({ store });
  return { store, registry };
}

export function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

export function extractRootPath(args: string[], flags: string[]): string | undefined {
  const skipSet = new Set<number>();
  for (const flag of flags) {
    const idx = args.indexOf(flag);
    if (idx !== -1) {
      skipSet.add(idx);
      if (idx + 1 < args.length) skipSet.add(idx + 1);
    }
  }
  for (let i = 0; i < args.length; i++) {
    if (!skipSet.has(i)) return args[i];
  }
  return undefined;
}

export async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  if (command === 'register') {
    const rootPath = args[0] ?? process.cwd();
    const archiveRoot = parseFlag(args, '--archive-root');
    const { store, registry } = getDeps();
    try {
      const project = registry.register(resolve(rootPath), archiveRoot ? resolve(archiveRoot) : undefined);
      console.log(`已注册项目: ${project.name} (${project.id})`);
      if (project.archiveRoot) {
        console.log(`归档位置: ${project.archiveRoot}`);
      }
    } finally {
      store.close();
    }
    return;
  }

  if (command === 'unregister') {
    const projectId = args[0];
    if (!projectId) {
      console.error('请提供项目 ID');
      process.exit(1);
    }
    const { store, registry } = getDeps();
    try {
      registry.unregister(projectId);
      console.log(`已注销项目: ${projectId}`);
    } finally {
      store.close();
    }
    return;
  }

  if (command === 'list') {
    const { store, registry } = getDeps();
    try {
      const projects = registry.list();
      for (const p of projects) {
        console.log(`${p.id}\t${p.name}\t${p.rootPath}`);
      }
    } finally {
      store.close();
    }
    return;
  }

  if (command === 'start') {
    const { store, registry } = getDeps();
    const cmdApiKey = parseFlag(args, '--api-key');
    const persisted = loadDaemonConfig();
    const daemon = new Daemon({
      registry,
      store,
      dbPath: DB_PATH,
      apiKey: cmdApiKey ?? persisted.apiKey,
      apiUrl: persisted.apiUrl,
      provider: persisted.provider,
      model: persisted.model,
      everos: persisted.everos,
      headers: persisted.headers,
      scanCron: persisted.scanCron,
      llmRequestsPerMinute: persisted.llmRequestsPerMinute,
    });
    daemon.start();
    console.log('守护进程已启动');
    process.on('SIGINT', async () => {
      await daemon.stop();
      store.close();
      process.exit(0);
    });
    return;
  }

  if (command === 'process') {
    const apiKey = parseFlag(args, '--api-key');
    if (!apiKey) {
      console.error('缺少 --api-key');
      process.exit(1);
    }
    const rootPath = extractRootPath(args, ['--api-key']);
    if (!rootPath) {
      console.error('请提供项目路径');
      process.exit(1);
    }
    const { store, registry } = getDeps();
    try {
      const projectId = makeProjectId(resolve(rootPath));
      const project = registry.get(projectId);
      if (!project) {
        console.error('项目未注册');
        process.exit(1);
      }
      const client = new LlmClient({ apiKey });
      const pipeline = new ArchivePipeline({ store, client });
      await pipeline.run(project);
      console.log('归档流程执行完成');
    } finally {
      store.close();
    }
    return;
  }

  if (command === 'status') {
    const { store, registry } = getDeps();
    try {
      const projects = registry.list();
      console.log(`已注册项目数: ${projects.length}`);
      for (const p of projects) {
        const pending = store.listPendingEvents(1000).filter((e) => e.projectId === p.id).length;
        console.log(`  ${p.name}: 待处理事件 ${pending}`);
      }
    } finally {
      store.close();
    }
    return;
  }

  if (command === 'history') {
    const rootPath = args[0];
    if (!rootPath) {
      console.error('请提供项目路径');
      process.exit(1);
    }
    const { store, registry } = getDeps();
    try {
      const projectId = makeProjectId(resolve(rootPath));
      const project = registry.get(projectId);
      if (!project) {
        console.error('项目未注册');
        process.exit(1);
      }
      const history = store.listActionHistory(project.id);
      console.log(`动作历史（${history.length} 条）`);
      for (const h of history) {
        const status = h.status === 'undone' ? '已撤销' : '已应用';
        console.log(`  ${h.id} [${h.type}] ${h.sourcePath} -> ${h.targetPath ?? '-'} (${status})`);
      }
    } finally {
      store.close();
    }
    return;
  }

  if (command === 'undo') {
    const actionId = args[0];
    const rootPath = args[1];
    if (!actionId || !rootPath) {
      console.error('用法: codekeeper-advance undo <action-id> <project-path>');
      process.exit(1);
    }
    const { store, registry } = getDeps();
    try {
      const projectId = makeProjectId(resolve(rootPath));
      const project = registry.get(projectId);
      if (!project) {
        console.error('项目未注册');
        process.exit(1);
      }
      const executor = new UndoExecutor({ store });
      const result = await executor.undo(actionId);
      console.log(result.message);
      if (!result.success) process.exit(1);
    } finally {
      store.close();
    }
    return;
  }

  console.log(`未知命令: ${command}`);
  console.log('用法: codekeeper-advance [register|unregister|list|start|process|status|history|undo]');
  process.exit(1);
}
