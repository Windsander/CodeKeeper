import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../../../../src/electron/renderer/contexts/ThemeContext';

function TestComponent() {
  const { theme, toggleTheme, loading } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="loading">{String(loading)}</span>
      <button onClick={toggleTheme}>切换</button>
    </div>
  );
}

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  window.electronAPI = {
    invoke: vi.fn(),
  } as unknown as Window['electronAPI'];
});

describe('ThemeContext', () => {
  it('默认暗色，读取 persisted 亮色后切换', async () => {
    (window.electronAPI.invoke as ReturnType<typeof vi.fn>).mockResolvedValue('light');
    render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    );

    expect(screen.getByTestId('loading').textContent).toBe('true');
    await waitFor(() => expect(screen.getByTestId('theme').textContent).toBe('light'));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('theme.get');
  });

  it('读取失败时回退到暗色', async () => {
    (window.electronAPI.invoke as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    );
    await waitFor(() => expect(screen.getByTestId('theme').textContent).toBe('dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('toggleTheme 切换主题并调用 theme.set', async () => {
    (window.electronAPI.invoke as ReturnType<typeof vi.fn>).mockResolvedValue('dark');
    render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    );
    await waitFor(() => expect(screen.getByTestId('theme').textContent).toBe('dark'));

    screen.getByText('切换').click();
    await waitFor(() => expect(screen.getByTestId('theme').textContent).toBe('light'));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.electronAPI.invoke).toHaveBeenLastCalledWith('theme.set', { theme: 'light' });
  });
});
