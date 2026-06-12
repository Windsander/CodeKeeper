import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MetadataStore } from './store/metadata-store';
import { ProjectRegistry } from './project-registry';
import { Daemon } from './daemon';

const DATA_DIR = join(homedir(), '.codekeeper-advance');
const DB_PATH = join(DATA_DIR, 'metadata.db');

function getDeps() {
  mkdirSync(DATA_DIR, { recursive: true });
  const store = new MetadataStore(DB_PATH);
  const registry = new ProjectRegistry({ store });
  return { store, registry };
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  if (command === 'register') {
    const rootPath = args[0] ?? process.cwd();
    const { store, registry } = getDeps();
    try {
      const project = registry.register(resolve(rootPath));
      console.log(`已注册项目: ${project.name} (${project.id})`);
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
    const daemon = new Daemon({ registry, store });
    daemon.start();
    console.log('守护进程已启动');
    process.on('SIGINT', () => {
      daemon.stop();
      store.close();
      process.exit(0);
    });
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

  console.log(`未知命令: ${command}`);
  console.log('用法: codekeeper-advance [register|unregister|list|start|status]');
  process.exit(1);
}

main();
