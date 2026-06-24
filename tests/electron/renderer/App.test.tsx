/**
 * App 路由与导航测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '../../../src/electron/renderer/App';
import '../../../src/electron/renderer/roles/reviewer-role.js';
import '../../../src/electron/renderer/roles/maintainer-role.js';

const mockInvoke = vi.fn();

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

describe('App 导航', () => {
  it('渲染 MR评审 和 自动维护 导航链接', () => {
    render(<App />);
    expect(screen.getByText('MR评审')).toBeTruthy();
    expect(screen.getByText('自动维护')).toBeTruthy();
  });
});
