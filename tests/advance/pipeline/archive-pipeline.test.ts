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
});
