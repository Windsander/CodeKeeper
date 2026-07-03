import type { LlmClient } from '../../llm/client.js';

/**
 * 上下文窗口选项
 */
export interface ContextWindowOptions {
  /** 原始内容 token 估算上限，超过才触发摘要；默认 8000 */
  maxRawTokens?: number;
  /** 摘要后保留的最近原文条数；默认 5 */
  maxRecentItems?: number;
  /** 单条 body 最大字符数；默认 2000 */
  maxCharsPerItem?: number;
}

/**
 * 整理后的讨论上下文
 */
export interface ThreadContext {
  /** 最近 N 条原文的文本表示 */
  recentNotesText: string;
  /** 对更早内容的摘要，未触发摘要时为 undefined */
  olderSummary?: string;
  /** 被摘要的早期条数 */
  summarizedCount: number;
  /** 是否触发了摘要 */
  summarized: boolean;
}

interface ThreadNote {
  author: string;
  body: string;
  createdAt: string;
}

/**
 * 估算文本 token 数（按字符数 / 4 粗略估算）
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 格式化单条 note
 */
function formatNote(note: ThreadNote, index?: number): string {
  const prefix = index !== undefined ? `【${index}】` : '';
  return `${prefix}${note.author} (${note.createdAt}):\n${note.body}`;
}

/**
 * 截断单条 body
 */
function truncateBody(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}…（已截断）`;
}

/**
 * 对 discussion 历史评论做窗口整理。
 *
 * 策略：
 * - 如果总 token 未超过 maxRawTokens，直接返回全部原文；
 * - 如果超过阈值，保留最近 maxRecentItems 条原文，对更早内容生成一段摘要。
 *
 * 生成的摘要同时可用于记忆查询的 taskSummary。
 */
export async function summarizeThreadNotes(
  llmClient: LlmClient,
  notes: ThreadNote[],
  options?: ContextWindowOptions
): Promise<ThreadContext> {
  const maxRawTokens = options?.maxRawTokens ?? 8000;
  const maxRecentItems = options?.maxRecentItems ?? 5;
  const maxCharsPerItem = options?.maxCharsPerItem ?? 2000;

  if (notes.length === 0) {
    return { recentNotesText: '', summarizedCount: 0, summarized: false };
  }

  const normalizedNotes = notes.map((n) => ({
    ...n,
    body: truncateBody(n.body, maxCharsPerItem),
  }));

  const allText = normalizedNotes.map((n, idx) => formatNote(n, idx + 1)).join('\n\n');
  const totalTokens = estimateTokens(allText);

  if (totalTokens <= maxRawTokens || notes.length <= maxRecentItems) {
    return {
      recentNotesText: allText,
      summarizedCount: 0,
      summarized: false,
    };
  }

  const recentNotes = normalizedNotes.slice(-maxRecentItems);
  const olderNotes = normalizedNotes.slice(0, -maxRecentItems);

  const recentNotesText = [
    ...(olderNotes.length > 0 ? [`（前面还有 ${olderNotes.length} 条评论，已摘要如下）`] : []),
    ...recentNotes.map((n, idx) => formatNote(n, olderNotes.length + idx + 1)),
  ].join('\n\n');

  const olderSummary = await summarizeNotes(llmClient, olderNotes);

  return {
    recentNotesText,
    olderSummary,
    summarizedCount: olderNotes.length,
    summarized: true,
  };
}

async function summarizeNotes(llmClient: LlmClient, notes: ThreadNote[]): Promise<string> {
  if (notes.length === 0) return '';

  const notesText = notes.map((n, idx) => formatNote(n, idx + 1)).join('\n\n');
  const prompt = `请对以下 discussion 历史评论做简洁摘要，用于后续回复时提供上下文。

要求：
- 保留关键争议点、用户核心诉求、已确认的事实；
- 不要逐条复述，合并成一段连贯文字；
- 控制在 300 字以内。

历史评论：
${notesText}

摘要：`;

  try {
    const summary = await llmClient.complete(prompt, '你是讨论摘要助手。');
    return summary.trim();
  } catch {
    // 摘要失败时 fallback 为简单提示，避免阻塞回复流程
    return `（前面 ${notes.length} 条评论因过长未完整展示）`;
  }
}

/**
 * 把 ThreadContext 拼成 prompt 中可用的讨论历史文本
 */
export function formatThreadContext(ctx: ThreadContext): string {
  const parts: string[] = [];
  if (ctx.olderSummary) {
    parts.push(`【早期评论摘要】\n${ctx.olderSummary}`);
  }
  if (ctx.recentNotesText) {
    parts.push(`【最近评论】\n${ctx.recentNotesText}`);
  }
  return parts.join('\n\n');
}
