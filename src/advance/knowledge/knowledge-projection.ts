/**
 * 知识投影：策展正本（Markdown 文件）→ EverOS 记忆索引。
 *
 * 方向单向：正本（人类/蒸馏落盘的文件）→ EverOS 检索层。
 * 以内容哈希去重（knowledge_projection 表），EverOS 侧数据可随时视为可重建：
 * 清空记忆后重跑投影即可恢复检索层。
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { logger } from '../core/logger.js';
import { everosMemoryAddMessages, everosMemoryFlush } from '../classic/memory/everos-api.js';
import type { EverOSAddMessage } from '../classic/memory/everos-api.js';
import type { Project } from '../types.js';
import { listProjectKnowledge, type KnowledgeItem } from './knowledge-store.js';

const APP_ID = 'codekeeper-advance';
/** 知识投影写入 EverOS 时使用的 owner/会话约定（与 archiver 的 record_project_knowledge 同级） */
const KNOWLEDGE_AGENT = 'knowledge-projection';

export interface ProjectionResult {
  total: number;
  synced: number;
  skipped: number;
  failed: number;
}

/** 把项目双正本中发生变化的知识条目投影到 EverOS */
export async function projectKnowledgeToEverOS(
  db: Database.Database,
  everosUrl: string,
  project: Project
): Promise<ProjectionResult> {
  const items = listProjectKnowledge(project);
  const result: ProjectionResult = { total: items.length, synced: 0, skipped: 0, failed: 0 };

  const upsertState = db.prepare(
    `INSERT INTO knowledge_projection (project_id, root, knowledge_id, content_hash, synced_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, root, knowledge_id)
     DO UPDATE SET content_hash = excluded.content_hash, synced_at = excluded.synced_at`
  );
  const getState = db.prepare(
    'SELECT content_hash FROM knowledge_projection WHERE project_id = ? AND root = ? AND knowledge_id = ?'
  );
  const deleteState = db.prepare(
    'DELETE FROM knowledge_projection WHERE project_id = ? AND root = ? AND knowledge_id = ?'
  );
  const syncedThisRound: KnowledgeItem[] = [];

  for (const item of items) {
    const hash = hashItem(item);
    const existing = getState.get(project.id, item.root, item.frontmatter.id) as
      | { content_hash: string }
      | undefined;
    if (existing?.content_hash === hash) {
      result.skipped += 1;
      continue;
    }

    try {
      const message: EverOSAddMessage = {
        senderId: KNOWLEDGE_AGENT,
        role: 'assistant',
        content: formatKnowledgeMessage(item),
        timestamp: Date.now(),
      };
      await everosMemoryAddMessages(
        everosUrl,
        { appId: APP_ID, projectId: project.id, sessionId: `knowledge-${project.id}` },
        [message]
      );
      upsertState.run(project.id, item.root, item.frontmatter.id, hash, Date.now());
      syncedThisRound.push(item);
      result.synced += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[KnowledgeProjection] 条目 ${item.frontmatter.id} 投影失败: ${message}`);
      result.failed += 1;
    }
  }

  if (result.synced > 0) {
    try {
      await everosMemoryFlush(everosUrl, {
        appId: APP_ID,
        projectId: project.id,
        sessionId: `knowledge-${project.id}`,
      });
    } catch (error) {
      // flush 失败：回滚本轮状态，下轮重新写入并 flush（避免消息滞留 buffer）
      for (const item of syncedThisRound) {
        deleteState.run(project.id, item.root, item.frontmatter.id);
      }
      result.synced = 0;
      result.failed += syncedThisRound.length;
      logger.warn({ err: error }, '[KnowledgeProjection] flush 失败，本轮状态已回滚');
    }
  }

  return result;
}

function hashItem(item: KnowledgeItem): string {
  return createHash('sha256')
    .update(JSON.stringify(item.frontmatter))
    .update('\n')
    .update(item.body)
    .digest('hex');
}

function formatKnowledgeMessage(item: KnowledgeItem): string {
  const fm = item.frontmatter;
  return [
    `[KNOWLEDGE:${fm.id}]`,
    `title: ${fm.title}`,
    `category: ${fm.category} | scope: ${fm.scope} | confidence: ${fm.confidence} | source: ${fm.source} | root: ${item.root}`,
    fm.tags.length > 0 ? `tags: ${fm.tags.join(', ')}` : '',
    '',
    item.body,
  ]
    .filter(line => line !== '')
    .join('\n');
}
