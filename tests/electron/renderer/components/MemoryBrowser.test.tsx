import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryBrowser } from '../../../../src/electron/renderer/components/MemoryBrowser';

const mockInvoke = vi.fn();

async function renderAndStabilize(ui: React.ReactElement) {
  const result = render(ui);
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  });
  return result;
}

describe('MemoryBrowser', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    window.electronAPI = {
      invoke: mockInvoke,
      onPush: vi.fn(() => () => {}),
      openExternal: vi.fn(),
      showOpenDialog: vi.fn(),
      windowMinimize: vi.fn(),
      windowMaximize: vi.fn(),
      windowClose: vi.fn(),
      onWindowStateChange: vi.fn(() => () => {}),
    } as unknown as Window['electronAPI'];
  });

  it('渲染项目下拉与搜索表单', async () => {
    mockInvoke.mockImplementation(async (method: string) => {
      if (method === 'project.list') return [{ id: 'p1', name: 'Test Project' }];
      return { entries: [] };
    });

    await renderAndStabilize(<MemoryBrowser />);

    expect(screen.getByText('记忆浏览器')).toBeTruthy();
    expect(screen.getByLabelText('项目')).toBeTruthy();
    expect(screen.getByLabelText('归属')).toBeTruthy();
    expect(screen.getByLabelText('关键词')).toBeTruthy();
  });

  it('选择 Agent 归属后显示 Agent ID 下拉', async () => {
    mockInvoke.mockImplementation(async (method: string) => {
      if (method === 'project.list') return [{ id: 'p1', name: 'Test Project' }];
      return { entries: [] };
    });

    await renderAndStabilize(<MemoryBrowser />);

    fireEvent.change(screen.getByLabelText('归属'), { target: { value: 'agent' } });
    expect(screen.getByLabelText('Agent ID')).toBeTruthy();
  });

  it('渲染记忆列表并支持删除', async () => {
    mockInvoke.mockImplementation(async (method: string) => {
      if (method === 'project.list') return [{ id: 'p1', name: 'Test Project' }];
      if (method === 'memory.search') {
        return {
          entries: [
            {
              id: 'ac-1',
              type: 'agent_case',
              content: '项目偏好 TypeScript 严格模式',
              source: 'archiver',
              timestamp: '2026-01-01T00:00:00Z',
              sessionId: 's1',
              score: 0.9,
            },
          ],
        };
      }
      return {};
    });

    window.confirm = vi.fn(() => true);

    await renderAndStabilize(<MemoryBrowser />);

    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'p1' } });

    await waitFor(() => {
      expect(screen.getByText('项目偏好 TypeScript 严格模式')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('删除'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('memory.delete', { projectId: 'p1', sessionId: 's1' });
    });
  });
});
