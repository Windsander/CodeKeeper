import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SystemStatusPage } from '../../../../src/electron/renderer/pages/SystemStatusPage.js';
import { useServiceStatus } from '../../../../src/electron/renderer/hooks/useServiceStatus.js';
import { LayoutProvider } from '../../../../src/electron/renderer/contexts/LayoutContext.js';

vi.mock('../../../../src/electron/renderer/hooks/useServiceStatus.js');

describe('SystemStatusPage', () => {
  it('把服务状态面板提升为独立页面', () => {
    vi.mocked(useServiceStatus).mockReturnValue({
      daemon: null,
      localModel: null,
      remoteModel: null,
      loading: true,
      error: null,
      refresh: vi.fn(),
    } as ReturnType<typeof useServiceStatus>);
    render(
      <LayoutProvider>
        <SystemStatusPage />
      </LayoutProvider>
    );
    expect(screen.getByText('系统状态')).toBeTruthy();
    expect(screen.getByText('加载服务状态...')).toBeTruthy();
  });
});
