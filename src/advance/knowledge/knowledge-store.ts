/**
 * 智库策展正本层（双正本）。
 *
 * 唯一事实源是 Markdown + YAML frontmatter 文件：
 * - 共享正本：<project>/.codekeeper/knowledge/（随项目入库，团队可见）
 * - 私有正本：~/.codekeeper/memory/knowledge/<projectId>/（本地私有）
 *
 * EverOS / CodeGraph 只是它们的可重建投影（见 knowledge-projection.ts）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { z } from 'zod';
import { getAppStorageDir } from '../core/platform.js';
import type { Project } from '../types.js';

/** 策展知识条目的 frontmatter */
export const knowledgeFrontmatterSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'id 必须是小写 slug'),
  title: z.string().min(1),
  category: z.enum(['convention', 'architecture', 'domain', 'risk', 'stack', 'graph']),
  /** project=项目内共享；system=跨项目共性（写入时仍可放项目根，投影时上移） */
  scope: z.enum(['project', 'system']).default('project'),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  source: z.enum(['human', 'distilled', 'archiver']).default('human'),
  tags: z.array(z.string()).default([]),
  updated: z.string().min(1),
});
export type KnowledgeFrontmatter = z.infer<typeof knowledgeFrontmatterSchema>;

export interface KnowledgeItem {
  frontmatter: KnowledgeFrontmatter;
  /** Markdown 正文 */
  body: string;
  /** 来源根：shared=项目入库；local=本地私有 */
  root: 'shared' | 'local';
  filePath: string;
}

export class KnowledgeStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeStoreError';
  }
}

/** 共享正本目录（项目内，入库） */
export function getSharedKnowledgeDir(project: Project): string {
  return join(project.rootPath, '.codekeeper', 'knowledge');
}

/** 私有正本目录（本地）；CK_KNOWLEDGE_LOCAL_ROOT 仅供测试注入 */
export function getLocalKnowledgeDir(project: Project): string {
  const override = process.env.CK_KNOWLEDGE_LOCAL_ROOT;
  const safeName = project.id.replace(/[\\/:*?"<>|]/g, '_');
  const base = override ?? join(getAppStorageDir(), 'memory', 'knowledge');
  return join(base, safeName);
}

/** 蒸馏草稿箱（共享根下，人审通过后才移入 knowledge/） */
export function getKnowledgeInboxDir(project: Project): string {
  return join(project.rootPath, '.codekeeper', 'knowledge-inbox');
}

/** 序列化条目为 Markdown + frontmatter */
export function serializeKnowledgeItem(item: {
  frontmatter: KnowledgeFrontmatter;
  body: string;
}): string {
  return `---\n${stringify(item.frontmatter)}---\n\n${item.body.trim()}\n`;
}

/** 解析 Markdown 文件为知识条目；非法时抛 KnowledgeStoreError */
export function parseKnowledgeItem(
  content: string,
  root: KnowledgeItem['root'],
  filePath: string
): KnowledgeItem {
  // Windows 编辑器常带 BOM，先剥离再匹配 frontmatter
  const normalized = content.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) {
    throw new KnowledgeStoreError(`知识条目缺少 frontmatter: ${filePath}`);
  }
  let rawFm: unknown;
  try {
    rawFm = parseYaml(match[1]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new KnowledgeStoreError(`知识条目 frontmatter 非法 YAML: ${filePath}: ${message}`);
  }
  const result = knowledgeFrontmatterSchema.safeParse(rawFm);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new KnowledgeStoreError(`知识条目 frontmatter 不符合 schema: ${filePath}: ${issues}`);
  }
  return { frontmatter: result.data, body: match[2].trim(), root, filePath };
}

/** 读取一个目录下的全部知识条目（非法文件跳过并记录） */
export function readKnowledgeDir(dir: string, root: KnowledgeItem['root']): KnowledgeItem[] {
  if (!existsSync(dir)) return [];
  const items: KnowledgeItem[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const filePath = join(dir, entry);
    try {
      items.push(parseKnowledgeItem(readFileSync(filePath, 'utf-8'), root, filePath));
    } catch {
      // 非法文件不阻断整体读取；调用方需要严格性时用 parseKnowledgeItem 直读
    }
  }
  return items;
}

/** 列出项目的全部策展知识（共享 + 私有） */
export function listProjectKnowledge(project: Project): KnowledgeItem[] {
  return [
    ...readKnowledgeDir(getSharedKnowledgeDir(project), 'shared'),
    ...readKnowledgeDir(getLocalKnowledgeDir(project), 'local'),
  ];
}

/** 写入共享正本（human 编辑 / 蒸馏草稿人审通过后的落点） */
export function writeSharedKnowledge(
  project: Project,
  item: { frontmatter: KnowledgeFrontmatter; body: string }
): string {
  const dir = getSharedKnowledgeDir(project);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${item.frontmatter.id}.md`);
  writeFileSync(filePath, serializeKnowledgeItem(item), 'utf-8');
  return filePath;
}

/** 写入私有正本 */
export function writeLocalKnowledge(
  project: Project,
  item: { frontmatter: KnowledgeFrontmatter; body: string }
): string {
  const dir = getLocalKnowledgeDir(project);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${item.frontmatter.id}.md`);
  writeFileSync(filePath, serializeKnowledgeItem(item), 'utf-8');
  return filePath;
}
