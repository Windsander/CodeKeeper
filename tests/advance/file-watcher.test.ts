import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileWatcher } from '../../src/advance/file-watcher';
import type { ProjectConfig } from '../../src/advance/config/project-config';

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
    const config: ProjectConfig = {
      name: 'test',
      include: ['**/*.md'],
      exclude: ['node_modules/**'],
      categories: [],
    };
    watcher.start({ projectRoot: dir, config, onEvent: (e) => events.push(e) });

    // 等待 chokidar 的 ready 事件，确保监听器已就绪
    await new Promise((resolve) => setTimeout(resolve, 300));
    writeFileSync(join(dir, 'readme.md'), '# hello');
    // 给 chokidar 更长时间来触发事件（WSL 文件系统可能较慢）
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(events.some((e) => e.type === 'add' && e.filePath.endsWith('readme.md'))).toBe(true);
  });
});
