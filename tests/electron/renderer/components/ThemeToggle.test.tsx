import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeToggle } from '../../../../src/electron/renderer/components/ThemeToggle';
import { ThemeProvider } from '../../../../src/electron/renderer/contexts/ThemeContext';

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  window.electronAPI = {
    invoke: vi.fn(),
  } as unknown as Window['electronAPI'];
});

describe('ThemeToggle', () => {
  it('暗色主题显示太阳图标和亮色提示', async () => {
    (window.electronAPI.invoke as ReturnType<typeof vi.fn>).mockResolvedValue('dark');
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>
    );
    const btn = await screen.findByTitle('切换到亮色主题');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain('切换亮色');
  });
});
