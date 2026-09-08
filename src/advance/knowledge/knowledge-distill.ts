/**
 * 知识蒸馏管线：EverOS 经验记忆 → 策展知识候选（人审草稿箱）。
 *
 * 承接旧版 learn 循环的精神（经验 → 策展知识），但以"人工检查点"为闸门：
 * LLM 产出的候选一律写入 knowledge-inbox/（source: distilled），
 * 由人类在 Knowledge tab 审阅后批准才进入正本。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { logger } from '../core/logger.js';
import type { LlmClient } from '../llm/client.js';
import { FilePromptLoader } from '../llm/prompts/loader.js';
import type { Project } from '../types.js';
import {
  getKnowledgeInboxDir,
  listProjectKnowledge,
  readKnowledgeDir,
  serializeKnowledgeItem,
  type KnowledgeFrontmatter,
} from './knowledge-store.js';

const candidateSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .catch(() => `c-${randomUUID().slice(0, 8)}`),
  title: z.string().min(1),
  category: z.enum(['convention', 'architecture', 'domain', 'risk', 'stack', 'graph']),
  confidence: z.enum(['high', 'medium', 'low']).default('low'),
  tags: z.array(z.string()).default([]),
  body: z.string().min(1),
});

const distillResponseSchema = z.object({
  candidates: z.array(candidateSchema).default([]),
});

export interface DistillResult {
  candidates: number;
  written: string[];
  skippedDuplicates: number;
}

/**
 * 从项目经验记忆蒸馏知识候选，写入人审草稿箱。
 * experiences：EverOS 中召回的近期经验文本（由调用方收集）。
 */
export async function distillKnowledgeCandidates(
  project: Project,
  llmClient: LlmClient,
  experiences: string[]
): Promise<DistillResult> {
  const result: DistillResult = { candidates: 0, written: [], skippedDuplicates: 0 };
  if (experiences.length === 0) return result;

  const promptLoader = new FilePromptLoader();
  const prompt = promptLoader.load('knowledge-distill', {
    experiences: experiences.join('\n\n---\n\n'),
  });

  const raw = await llmClient.completeJson(prompt, '你是项目智库的蒸馏器。', {
    type: 'object',
    properties: { candidates: { type: 'array' } },
    required: ['candidates'],
  });
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(raw);
  } catch {
    logger.warn('[KnowledgeDistill] 蒸馏结果不是合法 JSON，丢弃本轮');
    return result;
  }
  const parsed = distillResponseSchema.safeParse(parsedRaw);
  if (!parsed.success) {
    logger.warn(`[KnowledgeDistill] 蒸馏结果不符合 schema，丢弃本轮`);
    return result;
  }

  // 与既有正本及待审草稿都去重（同 id 不重复入草稿箱）
  const existingIds = new Set([
    ...listProjectKnowledge(project).map(item => item.frontmatter.id),
    ...readKnowledgeDir(getKnowledgeInboxDir(project), 'shared').map(item => item.frontmatter.id),
  ]);
  const inboxDir = getKnowledgeInboxDir(project);
  mkdirSync(inboxDir, { recursive: true });

  for (const candidate of parsed.data.candidates) {
    result.candidates += 1;
    if (existingIds.has(candidate.id)) {
      result.skippedDuplicates += 1;
      continue;
    }
    existingIds.add(candidate.id);
    const frontmatter: KnowledgeFrontmatter = {
      id: candidate.id,
      title: candidate.title,
      category: candidate.category,
      scope: 'project',
      confidence: candidate.confidence,
      source: 'distilled',
      tags: candidate.tags,
      updated: new Date().toISOString().slice(0, 10),
    };
    const filePath = join(inboxDir, `${frontmatter.id}.md`);
    writeFileSync(filePath, serializeKnowledgeItem({ frontmatter, body: candidate.body }), 'utf-8');
    result.written.push(filePath);
  }

  return result;
}
