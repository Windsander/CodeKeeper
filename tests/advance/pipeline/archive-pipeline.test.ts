import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
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

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cka-pipe-'));
    dbPath = join(tmp, 'metadata.db');
    projectRoot = join(tmp, 'project');
    mkdirSync(join(projectRoot, '.codekeeper'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('应消费 pending 事件并完成归档流程', async () => {
    const store = new MetadataStore(dbPath);
    const project: Project = {
      id: 'p1',
      rootPath: projectRoot,
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
      type: 'move',
      reason: '归档到 docs',
      targetPath: join(projectRoot, 'docs', 'memory-spec.md'),
      risk: 'low',
      confidence: 0.9,
    });

    const client = new LlmClient({
      apiKey: 'x',
      mock: {
        responses: [classifyResponse, suggestResponse],
      },
    });

    const pipeline = new ArchivePipeline({ store, client });
    await pipeline.run(project);

    // move 动作应已执行
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(join(projectRoot, 'docs', 'memory-spec.md'))).toBe(true);

    // status.json 应已生成
    const status = JSON.parse(readFileSync(join(projectRoot, '.codekeeper', 'status.json'), 'utf-8'));
    expect(status.projectId).toBe('p1');
    expect(status.archivedCount).toBe(1);

    // context.md 应已生成
    const context = readFileSync(join(projectRoot, '.codekeeper', 'context.md'), 'utf-8');
    expect(context).toContain('memory');

    store.close();
  });

  it('LLM 异常时不应阻塞后续事件', async () => {
    const store = new MetadataStore(dbPath);
    const project: Project = {
      id: 'p1',
      rootPath: projectRoot,
      name: '测试',
      registeredAt: 1,
      lastScannedAt: null,
    };
    store.registerProject(project);

    const failPath = join(projectRoot, 'fail.md');
    const okPath = join(projectRoot, 'ok.md');
    writeFileSync(failPath, '# 失败文档', 'utf-8');
    writeFileSync(okPath, '# 正常文档\n同步模块设计', 'utf-8');
    store.insertEvent({ projectId: project.id, type: 'add', filePath: failPath, timestamp: Date.now() });
    store.insertEvent({ projectId: project.id, type: 'add', filePath: okPath, timestamp: Date.now() + 1 });

    // 第一个事件 classify 抛异常，第二个事件 classify + suggest 正常
    const classifyOkResponse = JSON.stringify({
      category: 'sync',
      docType: 'spec',
      tags: ['sync'],
      summary: '同步模块设计',
      confidence: 0.9,
    });
    const suggestOkResponse = JSON.stringify({
      type: 'move',
      reason: '归档到 docs',
      targetPath: join(projectRoot, 'docs', 'sync-spec.md'),
      risk: 'low',
      confidence: 0.9,
    });

    // 使用自定义 LlmClient 子类：第一次调用抛异常，后续正常
    let callCount = 0;
    const client = new LlmClient({
      apiKey: 'x',
      mock: {
        responses: [],
      },
    });
    const originalComplete = client.complete.bind(client);
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
    expect(existsSync(join(projectRoot, 'docs', 'sync-spec.md'))).toBe(true);

    // 失败事件仍应留在 watch_events 中
    const pendingEvents = store.listPendingEvents();
    expect(pendingEvents.length).toBe(1);
    expect(pendingEvents[0].filePath).toBe(failPath);

    store.close();
  });

  it('应生成 suggestions.md', async () => {
    const store = new MetadataStore(dbPath);
    const project: Project = {
      id: 'p1',
      rootPath: projectRoot,
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
      type: 'move',
      reason: '归档到 docs',
      targetPath: join(projectRoot, 'docs', 'memory-spec.md'),
      risk: 'low',
      confidence: 0.9,
    });

    const client = new LlmClient({
      apiKey: 'x',
      mock: {
        responses: [classifyResponse, suggestResponse],
      },
    });

    const pipeline = new ArchivePipeline({ store, client });
    await pipeline.run(project);

    expect(existsSync(join(projectRoot, '.codekeeper', 'suggestions.md'))).toBe(true);

    store.close();
  });
});
