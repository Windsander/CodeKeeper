import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchivePipeline } from '../../../src/advance/pipeline/archive-pipeline';
import { MetadataStore } from '../../../src/advance/store/metadata-store';
import { LlmClient } from '../../../src/advance/llm/client';
import type { Project } from '../../../src/advance/types';

describe('ArchivePipeline', () => {
  let tmp: string;
  let dbPath: string;
  let projectRoot: string;
  let archiveRoot: string;
  let stores: MetadataStore[];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cka-pipe-'));
    dbPath = join(tmp, 'metadata.db');
    projectRoot = join(tmp, 'project');
    archiveRoot = join(tmp, 'archive');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(archiveRoot, { recursive: true });
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        // 忽略重复关闭
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('应消费 pending 事件并完成归档流程', async () => {
    const store = new MetadataStore(dbPath);
    stores.push(store);
    const project: Project = {
      id: 'p1',
      rootPath: projectRoot,
      archiveRoot,
      name: '测试',
      registeredAt: 1,
      lastScannedAt: null,
    };
    store.registerProject(project);

    const filePath = join(projectRoot, 'note.md');
    writeFileSync(filePath, '# 测试文档\n记忆模块设计', 'utf-8');
    utimesSync(
      filePath,
      new Date('2024-01-15T00:00:00.000Z'),
      new Date('2024-01-15T00:00:00.000Z')
    );
    store.insertEvent({ projectId: project.id, type: 'add', filePath, timestamp: Date.now() });

    const classifyResponse = JSON.stringify({
      category: 'memory',
      docType: 'spec',
      tags: ['memory'],
      summary: '记忆模块设计',
      confidence: 0.9,
    });
    const suggestResponse = JSON.stringify({
      type: 'copy',
      rationale: '归档到 docs',
      risk: 'low',
      confidence: 0.9,
      needsReview: false,
    });

    const client = new LlmClient({
      apiKey: 'x',
      mock: {
        responses: [classifyResponse, suggestResponse],
      },
    });

    const pipeline = new ArchivePipeline({ store, client });
    await pipeline.run(project);

    // copy 动作应保留原文件
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(join(archiveRoot, 'memory', 'spec', '2024-01', 'note.md'))).toBe(true);

    // status.json 应已生成
    const status = JSON.parse(readFileSync(join(archiveRoot, 'status.json'), 'utf-8'));
    expect(status.projectId).toBe('p1');
    expect(status.archivedCount).toBe(1);

    // context.md 应已生成
    const context = readFileSync(join(archiveRoot, 'context.md'), 'utf-8');
    expect(context).toContain('memory');
  });

  it('LLM 异常时不应阻塞后续事件', async () => {
    const store = new MetadataStore(dbPath);
    stores.push(store);
    const project: Project = {
      id: 'p1',
      rootPath: projectRoot,
      archiveRoot,
      name: '测试',
      registeredAt: 1,
      lastScannedAt: null,
    };
    store.registerProject(project);

    const failPath = join(projectRoot, 'fail.md');
    const okPath = join(projectRoot, 'ok.md');
    writeFileSync(failPath, '# 失败文档', 'utf-8');
    writeFileSync(okPath, '# 正常文档\n同步模块设计', 'utf-8');
    const modifiedAt = new Date('2024-01-15T00:00:00.000Z');
    utimesSync(failPath, modifiedAt, modifiedAt);
    utimesSync(okPath, modifiedAt, modifiedAt);
    store.insertEvent({
      projectId: project.id,
      type: 'add',
      filePath: failPath,
      timestamp: Date.now(),
    });
    store.insertEvent({
      projectId: project.id,
      type: 'add',
      filePath: okPath,
      timestamp: Date.now() + 1,
    });

    const classifyOkResponse = JSON.stringify({
      category: 'sync',
      docType: 'spec',
      tags: ['sync'],
      summary: '同步模块设计',
      confidence: 0.9,
    });
    const suggestOkResponse = JSON.stringify({
      type: 'copy',
      rationale: '归档',
      risk: 'low',
      confidence: 0.9,
      needsReview: false,
    });

    let callCount = 0;
    const client = new LlmClient({
      apiKey: 'x',
      mock: {
        responses: [],
      },
    });
    client.complete = async (prompt: string, system?: string) => {
      callCount++;
      if (callCount <= 1) {
        throw new Error('LLM 模拟异常');
      }
      if (callCount === 2) {
        return classifyOkResponse;
      }
      return suggestOkResponse;
    };

    const pipeline = new ArchivePipeline({ store, client });
    await pipeline.run(project);

    // 第二个事件应成功归档
    expect(existsSync(join(archiveRoot, 'sync', 'spec', '2024-01', 'ok.md'))).toBe(true);

    // 失败事件仍应留在 watch_events 中
    const pendingEvents = store.listPendingEvents();
    expect(pendingEvents.length).toBe(1);
    expect(pendingEvents[0].filePath).toBe(failPath);
  });

  it('应生成 suggestions.md', async () => {
    const store = new MetadataStore(dbPath);
    stores.push(store);
    const project: Project = {
      id: 'p1',
      rootPath: projectRoot,
      archiveRoot,
      name: '测试',
      registeredAt: 1,
      lastScannedAt: null,
    };
    store.registerProject(project);

    const filePath = join(projectRoot, 'note.md');
    writeFileSync(filePath, '# 测试文档\n记忆模块设计', 'utf-8');
    store.insertEvent({ projectId: project.id, type: 'add', filePath, timestamp: Date.now() });

    const classifyResponse = JSON.stringify({
      category: 'memory',
      docType: 'spec',
      tags: ['memory'],
      summary: '记忆模块设计',
      confidence: 0.9,
    });
    const suggestResponse = JSON.stringify({
      type: 'copy',
      rationale: '归档到 docs',
      risk: 'low',
      confidence: 0.9,
      needsReview: false,
    });

    const client = new LlmClient({
      apiKey: 'x',
      mock: {
        responses: [classifyResponse, suggestResponse],
      },
    });

    const pipeline = new ArchivePipeline({ store, client });
    await pipeline.run(project);

    expect(existsSync(join(archiveRoot, 'suggestions.md'))).toBe(true);
  });

  it('已入队的嵌套依赖文档应被直接忽略', async () => {
    const store = new MetadataStore(dbPath);
    stores.push(store);
    const project: Project = {
      id: 'p1',
      rootPath: projectRoot,
      archiveRoot,
      name: '测试',
      registeredAt: 1,
      lastScannedAt: null,
    };
    store.registerProject(project);

    const filePath = join(
      projectRoot,
      'packages',
      'feature',
      'node_modules',
      'dependency',
      'CHANGELOG.md'
    );
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, '# dependency changes', 'utf8');
    store.insertEvent({ projectId: project.id, type: 'add', filePath, timestamp: Date.now() });
    const completeJson = vi.fn();
    const client = { completeJson } as unknown as LlmClient;

    const pipeline = new ArchivePipeline({ store, client });
    await pipeline.run(project);

    expect(completeJson).not.toHaveBeenCalled();
    expect(store.listPendingEvents()).toEqual([]);
    expect(store.listArchiveMetadataByProject(project.id)).toEqual([]);
  });
});
