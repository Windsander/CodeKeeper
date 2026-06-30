import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LocalModelLogViewer } from '../../../../src/electron/renderer/components/LocalModelLogViewer';
import { useModelLogs } from '../../../../src/electron/renderer/hooks/useModelLogs';

vi.mock('../../../../src/electron/renderer/hooks/useModelLogs', () => ({
  useModelLogs: vi.fn(),
}));

describe('LocalModelLogViewer', () => {
  it('渲染 Embedding 与 Rerank 日志', () => {
    vi.mocked(useModelLogs).mockReturnValue({
      embedding: ['[stdout] embedding log'],
      rerank: ['[stderr] rerank log'],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<LocalModelLogViewer />);

    expect(screen.getByText('Embedding')).toBeTruthy();
    expect(screen.getByText('Rerank')).toBeTruthy();
    expect(screen.getByText('[stdout] embedding log')).toBeTruthy();
    expect(screen.getByText('[stderr] rerank log')).toBeTruthy();
  });

  it('无日志时显示占位文案', () => {
    vi.mocked(useModelLogs).mockReturnValue({
      embedding: [],
      rerank: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<LocalModelLogViewer />);

    expect(screen.getAllByText('暂无日志').length).toBe(2);
  });
});
