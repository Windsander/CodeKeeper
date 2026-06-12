import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileWatcher } from '../../src/advance/file-watcher';
import type { ProjectConfig } from '../../src/advance/config/project-config';

async function waitCondition(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待条件超时（${timeoutMs}ms）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('FileWatcher', () => {
  let dir: string;
  let watcher: FileWatcher;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ck-watch-'));
    watcher = new FileWatcher();
  });

  afterEach(() => {
    watcher.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('能监听到新增文件事件', async () => {
    const events: { type: string; filePath: string }[] = [];
    let ready = false;
    const config: ProjectConfig = {
      name: 'test',
      include: ['**/*.md'],
      exclude: ['node_modules/**'],
      categories: [],
    };

    watcher.start({
      projectRoot: dir,
      config,
      onEvent: (e) => events.push(e),
      onReady: () => { ready = true; },
    });

    await waitCondition(() => ready, 3000);
    writeFileSync(join(dir, 'readme.md'), '# hello');
    await waitCondition(
      () => events.some((e) => e.type === 'add' && e.filePath.endsWith('readme.md')),
      3000
    );

    expect(events.some((e) => e.type === 'add' && e.filePath.endsWith('readme.md'))).toBe(true);
  }, 10000);

  it('能监听到文件修改事件', async () => {
    const events: { type: string; filePath: string }[] = [];
    let ready = false;
    const config: ProjectConfig = {
      name: 'test',
      include: ['**/*.md'],
      exclude: ['node_modules/**'],
      categories: [],
    };

    // 先创建文件，再启动监听器
    writeFileSync(join(dir, 'note.md'), 'initial');

    watcher.start({
      projectRoot: dir,
      config,
      onEvent: (e) => events.push(e),
      onReady: () => { ready = true; },
    });

    await waitCondition(() => ready, 3000);
    writeFileSync(join(dir, 'note.md'), 'updated');
    await waitCondition(
      () => events.some((e) => e.type === 'change' && e.filePath.endsWith('note.md')),
      3000
    );

    expect(events.some((e) => e.type === 'change' && e.filePath.endsWith('note.md'))).toBe(true);
  }, 10000);

  it('能监听到文件删除事件', async () => {
    const events: { type: string; filePath: string }[] = [];
    let ready = false;
    const config: ProjectConfig = {
      name: 'test',
      include: ['**/*.md'],
      exclude: ['node_modules/**'],
      categories: [],
    };

    // 先创建文件，再启动监听器
    const filePath = join(dir, 'temp.md');
    writeFileSync(filePath, 'to be deleted');

    watcher.start({
      projectRoot: dir,
      config,
      onEvent: (e) => events.push(e),
      onReady: () => { ready = true; },
    });

    await waitCondition(() => ready, 3000);
    rmSync(filePath, { force: true });
    await waitCondition(
      () => events.some((e) => e.type === 'unlink' && e.filePath.endsWith('temp.md')),
      3000
    );

    expect(events.some((e) => e.type === 'unlink' && e.filePath.endsWith('temp.md'))).toBe(true);
  }, 10000);
});
