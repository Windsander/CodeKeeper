/**
 * App 路由与导航测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { App } from '../../../src/electron/renderer/App';
import { useServiceStatus } from '../../../src/electron/renderer/hooks/useServiceStatus';
import '../../../src/electron/renderer/roles/reviewer-role.js';
import '../../../src/electron/renderer/roles/maintainer-role.js';
import '../../../src/electron/renderer/roles/archiver-role.js';

vi.mock('../../../src/electron/renderer/hooks/useServiceStatus');

const mockInvoke = vi.fn();

function makeServiceStatus(overrides: Partial<ReturnType<typeof useServiceStatus>> = {}) {
  return {
    daemon: null,
    localModel: null,
    remoteModel: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    ...overrides,
  } as ReturnType<typeof useServiceStatus>;
}

beforeEach(() => {
  vi.useRealTimers();
  vi.mocked(useServiceStatus).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((method: string) => {
    if (method === 'theme.get') return Promise.resolve('dark');
    return Promise.resolve(null);
  });
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

describe('App 导航', () => {
  it('渲染三个角色导航链接', async () => {
    vi.mocked(useServiceStatus).mockReturnValue(makeServiceStatus({ loading: true }));
    render(<App />);
    expect(screen.getByText('记忆图谱')).toBeTruthy();
    expect(screen.getByText('记忆统计')).toBeTruthy();
    expect(screen.getByText('自动评审')).toBeTruthy();
    expect(screen.getByText('自动维护')).toBeTruthy();
    expect(screen.getByText('项目知识')).toBeTruthy();
    expect(await screen.findByTitle('切换到亮色主题')).toBeTruthy();
  });
});

describe('App 启动就绪控制', () => {
  it('服务未就绪时默认进入设置页', async () => {
    vi.mocked(useServiceStatus).mockReturnValue(makeServiceStatus({ loading: true }));
    render(<App />);
    expect(await screen.findByText('大语言模型')).toBeTruthy();
  });

  it('服务未就绪时非设置导航项被禁用', async () => {
    vi.mocked(useServiceStatus).mockReturnValue(makeServiceStatus({ loading: true }));
    render(<App />);
    const nav = screen.getByText('记忆图谱').closest('.sidebar-link');
    expect(nav?.getAttribute('aria-disabled')).toBe('true');
  });

  it('服务未就绪时直接访问非设置路由会重定向到设置页', async () => {
    window.history.pushState({}, '', '/memory');
    vi.mocked(useServiceStatus).mockReturnValue(makeServiceStatus({ loading: true }));
    render(<App />);
    expect(await screen.findByText('大语言模型')).toBeTruthy();
  });

  it('服务就绪后显示 toast，10 秒后自动消失', async () => {
    vi.useFakeTimers();
    vi.mocked(useServiceStatus).mockReturnValue(makeServiceStatus({ loading: true }));
    const { rerender } = render(<App />);

    vi.mocked(useServiceStatus).mockReturnValue(
      makeServiceStatus({
        loading: false,
        daemon: {
          daemonRunning: true,
          everos: { state: 'running', url: 'http://127.0.0.1:9999', error: null },
          codeGraph: {
            state: 'running',
            url: 'http://127.0.0.1:7010',
            error: null,
            activeJobs: 0,
            queuedJobs: 0,
            providers: [],
          },
        } as any,
        localModel: {
          embedding: { state: 'running', url: null, error: null, progress: null },
          rerank: { state: 'running', url: null, error: null, progress: null },
        } as any,
      })
    );

    act(() => {
      rerender(<App />);
    });

    expect(screen.getByText('所有本地服务已就绪，可以开始使用')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(screen.queryByText('所有本地服务已就绪，可以开始使用')).toBeNull();
  });
});
