import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Logs } from '../../../../src/electron/renderer/pages/Logs';
import { useModelLogs } from '../../../../src/electron/renderer/hooks/useModelLogs';

// jsdom 未实现 scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

vi.mock('../../../../src/electron/renderer/hooks/useIpc', () => ({
  useIpc: vi.fn().mockReturnValue({
    data: { lines: ['[INFO] daemon log line'] },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('../../../../src/electron/renderer/hooks/useModelLogs', () => ({
  useModelLogs: vi.fn(),
}));

describe('Logs', () => {
  beforeEach(() => {
    vi.mocked(useModelLogs).mockReturnValue({
      embedding: ['[stderr] embedding infinity_emb log'],
      rerank: ['[stderr] rerank warmup log'],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  it('默认渲染全部日志选项卡', () => {
    render(<Logs />);

    expect(screen.getByText('全部日志')).toBeTruthy();
    expect(screen.getByText('本地模型')).toBeTruthy();
    expect(screen.getByText('[INFO] daemon log line')).toBeTruthy();
  });

  it('切换到本地模型选项卡显示过滤后的模型日志', () => {
    render(<Logs />);

    fireEvent.click(screen.getByText('本地模型'));

    expect(screen.getByText(/embedding infinity_emb/)).toBeTruthy();
    expect(screen.getByText(/rerank warmup/)).toBeTruthy();
  });

  it('本地模型选项卡过滤掉无关访问日志', () => {
    vi.mocked(useModelLogs).mockReturnValue({
      embedding: ['GET /docs HTTP/1.1" 404 Not Found'],
      rerank: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<Logs />);
    fireEvent.click(screen.getByText('本地模型'));

    expect(screen.queryByText(/GET \/docs/)).toBeNull();
  });
});
