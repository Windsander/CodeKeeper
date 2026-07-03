import { describe, it, expect, vi } from 'vitest';
import {
  summarizeThreadNotes,
  formatThreadContext,
} from '../../../../src/advance/classic/utils/context-window.js';
import type { LlmClient } from '../../../../src/advance/llm/client.js';

function createMockLlm(response: string): LlmClient {
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LlmClient;
}

function makeNotes(count: number, bodyLength: number) {
  return Array.from({ length: count }, (_, i) => ({
    author: i % 2 === 0 ? 'alice' : 'reviewer',
    body: `第 ${i + 1} 条评论。${'x'.repeat(bodyLength)}`,
    createdAt: `2026-07-03T06:${String(i).padStart(2, '0')}:00Z`,
  }));
}

describe('summarizeThreadNotes', () => {
  it('空数组返回空上下文', async () => {
    const ctx = await summarizeThreadNotes(createMockLlm(''), []);
    expect(ctx.recentNotesText).toBe('');
    expect(ctx.summarized).toBe(false);
  });

  it('短线程直接返回全部原文，不生成摘要', async () => {
    const notes = makeNotes(3, 100);
    const llmClient = createMockLlm('');
    const ctx = await summarizeThreadNotes(llmClient, notes, { maxRawTokens: 8000 });

    expect(ctx.summarized).toBe(false);
    expect(ctx.olderSummary).toBeUndefined();
    expect(ctx.recentNotesText).toContain('第 1 条评论');
    expect(ctx.recentNotesText).toContain('第 3 条评论');
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it('长线程触发摘要并保留最近 N 条原文', async () => {
    const notes = makeNotes(20, 2500);
    const llmClient = createMockLlm('早期评论摘要：用户在追问 medium issue 的处理方式。');
    const ctx = await summarizeThreadNotes(llmClient, notes, {
      maxRawTokens: 8000,
      maxRecentItems: 5,
    });

    expect(ctx.summarized).toBe(true);
    expect(ctx.summarizedCount).toBe(15);
    expect(ctx.olderSummary).toBe('早期评论摘要：用户在追问 medium issue 的处理方式。');
    expect(ctx.recentNotesText).toContain('第 16 条评论');
    expect(ctx.recentNotesText).toContain('第 20 条评论');
    expect(ctx.recentNotesText).not.toContain('第 1 条评论');
    expect(llmClient.complete).toHaveBeenCalledTimes(1);
  });

  it('单条 body 超长时截断', async () => {
    const notes = [{ author: 'alice', body: 'x'.repeat(5000), createdAt: '2026-07-03T06:00:00Z' }];
    const ctx = await summarizeThreadNotes(createMockLlm(''), notes, {
      maxRawTokens: 8000,
      maxCharsPerItem: 2000,
    });

    expect(ctx.recentNotesText.length).toBeLessThan(5000);
    expect(ctx.recentNotesText).toContain('（已截断）');
  });

  it('摘要生成失败时 fallback 到简单提示', async () => {
    const notes = makeNotes(20, 2500);
    const llmClient = {
      complete: vi.fn().mockRejectedValue(new Error('摘要失败')),
    } as unknown as LlmClient;
    const ctx = await summarizeThreadNotes(llmClient, notes, {
      maxRawTokens: 8000,
      maxRecentItems: 5,
    });

    expect(ctx.summarized).toBe(true);
    expect(ctx.olderSummary).toContain('15 条评论');
  });
});

describe('formatThreadContext', () => {
  it('有摘要和原文时同时包含两者', () => {
    const text = formatThreadContext({
      recentNotesText: '最近评论',
      olderSummary: '早期摘要',
      summarizedCount: 5,
      summarized: true,
    });

    expect(text).toContain('早期摘要');
    expect(text).toContain('最近评论');
  });

  it('无摘要时只包含原文', () => {
    const text = formatThreadContext({
      recentNotesText: '全部原文',
      summarizedCount: 0,
      summarized: false,
    });

    expect(text).toBe('【最近评论】\n全部原文');
  });
});
