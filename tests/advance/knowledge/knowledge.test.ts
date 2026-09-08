import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { readFileSync as readSchema } from 'node:fs';
import {
  getKnowledgeInboxDir,
  getSharedKnowledgeDir,
  listProjectKnowledge,
  parseKnowledgeItem,
  serializeKnowledgeItem,
  writeSharedKnowledge,
  KnowledgeStoreError,
  type KnowledgeFrontmatter,
} from '../../../src/advance/knowledge/knowledge-store.js';
import { projectKnowledgeToEverOS } from '../../../src/advance/knowledge/knowledge-projection.js';
import { distillKnowledgeCandidates } from '../../../src/advance/knowledge/knowledge-distill.js';
import type { Project } from '../../../src/advance/types.js';

function makeProject(rootPath: string): Project {
  return { id: 'proj-kb', name: '知识项目', rootPath } as Project;
}

function makeItem(
  id: string,
  title = '示例知识'
): {
  frontmatter: KnowledgeFrontmatter;
  body: string;
} {
  return {
    frontmatter: {
      id,
      title,
      category: 'convention',
      scope: 'project',
      confidence: 'high',
      source: 'human',
      tags: ['api'],
      updated: '2026-09-08',
    },
    body: '项目约定：所有 API 走网关。',
  };
}

describe('knowledge-store', () => {
  // 私有正本根隔离到临时目录，避免读到真实用户目录
  beforeEach(() => {
    process.env.CK_KNOWLEDGE_LOCAL_ROOT = mkdtempSync(join(tmpdir(), 'ck-kb-local-'));
  });
  afterEach(() => {
    delete process.env.CK_KNOWLEDGE_LOCAL_ROOT;
  });

  it('frontmatter 序列化/解析往返一致', () => {
    const item = makeItem('api-gateway');
    const text = serializeKnowledgeItem(item);
    const parsed = parseKnowledgeItem(text, 'shared', 'virtual/api-gateway.md');
    expect(parsed.frontmatter).toEqual(item.frontmatter);
    expect(parsed.body).toBe(item.body);
  });

  it('缺 frontmatter / 非法 schema 抛 KnowledgeStoreError', () => {
    expect(() => parseKnowledgeItem('# 没有头部', 'shared', 'virtual/x.md')).toThrow(
      KnowledgeStoreError
    );
    expect(() =>
      parseKnowledgeItem('---\nid: BAD ID\ntitle: x\n---\nbody', 'shared', 'virtual/x.md')
    ).toThrow(/slug/);
  });

  it('容忍 UTF-8 BOM（Windows 编辑器常见）', () => {
    const text = '﻿' + serializeKnowledgeItem(makeItem('bom-item'));
    const parsed = parseKnowledgeItem(text, 'shared', 'virtual/bom.md');
    expect(parsed.frontmatter.id).toBe('bom-item');
  });

  it('writeSharedKnowledge 写入项目内 .codekeeper/knowledge/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-kb-'));
    try {
      const project = makeProject(dir);
      const path = writeSharedKnowledge(project, makeItem('conv-1'));
      expect(path).toBe(join(getSharedKnowledgeDir(project), 'conv-1.md'));
      const items = listProjectKnowledge(project);
      expect(items).toHaveLength(1);
      expect(items[0].root).toBe('shared');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('knowledge-projection', () => {
  beforeEach(() => {
    process.env.CK_KNOWLEDGE_LOCAL_ROOT = mkdtempSync(join(tmpdir(), 'ck-kb-proj-local-'));
  });
  afterEach(() => {
    delete process.env.CK_KNOWLEDGE_LOCAL_ROOT;
  });

  function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec(readSchema(join(__dirname, '../../../src/advance/store/schema.sql'), 'utf-8'));
    return db;
  }

  it('变更条目投影到 EverOS，未变更跳过；重复执行幂等', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-kb-proj-'));
    const added: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (String(url).includes('/memory/add')) {
          added.push(JSON.parse(init?.body ?? '{}'));
        }
        return { ok: true, json: async () => ({}) } as Response;
      })
    );
    try {
      const project = makeProject(dir);
      writeSharedKnowledge(project, makeItem('conv-1'));
      const db = makeDb();

      const first = await projectKnowledgeToEverOS(db, 'http://everos.invalid', project);
      expect(first).toMatchObject({ total: 1, synced: 1, skipped: 0, failed: 0 });
      expect(added).toHaveLength(1);

      // 内容未变 → 全部跳过
      const second = await projectKnowledgeToEverOS(db, 'http://everos.invalid', project);
      expect(second).toMatchObject({ total: 1, synced: 0, skipped: 1 });

      // 内容变化 → 重新投影
      writeSharedKnowledge(project, { ...makeItem('conv-1'), body: '更新后的约定' });
      const third = await projectKnowledgeToEverOS(db, 'http://everos.invalid', project);
      expect(third).toMatchObject({ synced: 1, skipped: 0 });
      expect(added).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('双正本同 id 不同内容：两根独立跟踪，不互相污染幂等状态', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-kb-dual-'));
    const localRoot = mkdtempSync(join(tmpdir(), 'ck-kb-local2-'));
    process.env.CK_KNOWLEDGE_LOCAL_ROOT = localRoot;
    const added: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (String(url).includes('/memory/add')) {
          added.push(JSON.parse(init?.body ?? '{}'));
        }
        return { ok: true, json: async () => ({}) } as Response;
      })
    );
    try {
      const project = makeProject(dir);
      writeSharedKnowledge(project, makeItem('dup-id', '共享版'));
      // 私有正本同 id、不同内容
      const localDir = join(localRoot, project.id.replace(/[\\/:*?"<>|]/g, '_'));
      mkdirSync(localDir, { recursive: true });
      writeFileSync(
        join(localDir, 'dup-id.md'),
        serializeKnowledgeItem({
          frontmatter: makeItem('dup-id', '私有版').frontmatter,
          body: '私有内容',
        })
      );

      const db = makeDb();
      const first = await projectKnowledgeToEverOS(db, 'http://everos.invalid', project);
      expect(first).toMatchObject({ total: 2, synced: 2, skipped: 0 });

      // 第二轮：全部幂等跳过（若状态键不含 root，会每轮重投）
      const second = await projectKnowledgeToEverOS(db, 'http://everos.invalid', project);
      expect(second).toMatchObject({ total: 2, synced: 0, skipped: 2 });
      expect(added).toHaveLength(2);
    } finally {
      delete process.env.CK_KNOWLEDGE_LOCAL_ROOT;
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
      rmSync(localRoot, { recursive: true, force: true });
    }
  });
});

describe('knowledge-distill', () => {
  beforeEach(() => {
    process.env.CK_KNOWLEDGE_LOCAL_ROOT = mkdtempSync(join(tmpdir(), 'ck-kb-distill-local-'));
  });
  afterEach(() => {
    delete process.env.CK_KNOWLEDGE_LOCAL_ROOT;
  });

  it('LLM 产出候选写入 inbox，与正本去重', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-kb-distill-'));
    try {
      const project = makeProject(dir);
      // 正本已有 conv-1，候选重复应跳过
      writeSharedKnowledge(project, makeItem('conv-1'));

      const llm = {
        completeJson: vi.fn().mockResolvedValue(
          JSON.stringify({
            candidates: [
              {
                id: 'conv-1',
                title: '重复',
                category: 'convention',
                confidence: 'low',
                tags: [],
                body: 'dup',
              },
              {
                id: 'risk-auth',
                title: '鉴权风险',
                category: 'risk',
                confidence: 'medium',
                tags: ['auth'],
                body: '鉴权绕过曾在 MR 中反复出现。',
              },
            ],
          })
        ),
      };

      const result = await distillKnowledgeCandidates(project, llm as never, ['经验文本']);
      expect(result.candidates).toBe(2);
      expect(result.skippedDuplicates).toBe(1);
      expect(result.written).toHaveLength(1);

      const inboxFile = join(getKnowledgeInboxDir(project), 'risk-auth.md');
      expect(existsSync(inboxFile)).toBe(true);
      const parsed = parseKnowledgeItem(readFileSync(inboxFile, 'utf-8'), 'shared', inboxFile);
      expect(parsed.frontmatter.source).toBe('distilled');
      expect(parsed.frontmatter.confidence).toBe('medium');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('LLM 返回垃圾时不写任何文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-kb-distill-bad-'));
    try {
      const project = makeProject(dir);
      const llm = { completeJson: vi.fn().mockResolvedValue('不是 JSON') };
      const result = await distillKnowledgeCandidates(project, llm as never, ['经验']);
      expect(result.written).toHaveLength(0);
      expect(existsSync(getKnowledgeInboxDir(project))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('空经验列表直接返回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-kb-distill-empty-'));
    try {
      const project = makeProject(dir);
      const llm = { completeJson: vi.fn() };
      const result = await distillKnowledgeCandidates(project, llm as never, []);
      expect(result.candidates).toBe(0);
      expect(llm.completeJson).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
