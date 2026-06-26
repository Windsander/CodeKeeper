import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ServiceStatusPanel } from '../../../../src/electron/renderer/components/ServiceStatusPanel';
import type { DaemonStatus, LocalModelStatus } from '../../../../src/electron/shared/service-status';

describe('ServiceStatusPanel', () => {
  it('渲染 Daemon → 记忆服务（EverOS）/本地模型服务 → Embedding/Rerank 树形结构', () => {
    const daemon: DaemonStatus = {
      daemonRunning: true,
      everos: { state: 'running', url: 'http://127.0.0.1:8000', error: null },
    };
    const localModel: LocalModelStatus = {
      embedding: { state: 'running', url: 'http://127.0.0.1:12345', error: null },
      rerank: { state: 'running', url: 'http://127.0.0.1:12346', error: null },
    };

    render(
      <ServiceStatusPanel
        daemon={daemon}
        localModel={localModel}
      />
    );

    expect(screen.getByText('服务状态')).toBeTruthy();
    expect(screen.getByText('Daemon')).toBeTruthy();
    expect(screen.getByText('记忆服务（EverOS）')).toBeTruthy();
    expect(screen.getByText('本地模型服务')).toBeTruthy();
    expect(screen.getByText('Embedding')).toBeTruthy();
    expect(screen.getByText('Rerank')).toBeTruthy();
  });

  it('根据状态显示对应颜色 badge', () => {
    const daemon: DaemonStatus = {
      daemonRunning: true,
      everos: { state: 'starting', url: null, error: null },
    };
    const localModel: LocalModelStatus = {
      embedding: { state: 'downloading', url: null, error: null },
      rerank: { state: 'loading', url: null, error: null },
    };

    const { container } = render(
      <ServiceStatusPanel
        daemon={daemon}
        localModel={localModel}
        loading={false}
        error={null}
      />
    );

    expect(container.querySelector('.badge-success')?.textContent).toBe('运行中');
    expect(container.querySelector('.badge-info')?.textContent).toBe('启动中');
    expect(container.querySelector('.badge-warning')?.textContent).toBe('下载中');
    expect(container.textContent).toContain('加载中');
  });

  it('错误状态可点击展开，显示截断错误摘要', () => {
    const longError = 'a'.repeat(300);
    const daemon: DaemonStatus = {
      daemonRunning: true,
      everos: { state: 'error', url: null, error: longError },
    };
    const localModel: LocalModelStatus = {
      embedding: { state: 'error', url: null, error: 'embedding 启动失败' },
      rerank: { state: 'idle', url: null, error: null },
    };

    render(
      <ServiceStatusPanel
        daemon={daemon}
        localModel={localModel}
        loading={false}
        error={null}
      />
    );

    // 点击记忆服务（EverOS）错误行展开
    fireEvent.click(screen.getByText('记忆服务（EverOS）'));
    const everosNode = screen.getByTestId('status-node-everos');
    const everosError = within(everosNode).getByText(/a{200}/);
    expect(everosError).toBeTruthy();
    expect(everosNode.querySelector('.service-status-error')?.classList.contains('service-status-error--expanded')).toBe(true);

    // 点击 Embedding 错误行展开
    fireEvent.click(screen.getByText('Embedding'));
    const embeddingNode = screen.getByTestId('status-node-embedding');
    expect(within(embeddingNode).getByText('embedding 启动失败')).toBeTruthy();
    expect(embeddingNode.querySelector('.service-status-error')?.classList.contains('service-status-error--expanded')).toBe(true);
  });

  it('running 节点显示 URL', () => {
    const daemon: DaemonStatus = {
      daemonRunning: true,
      everos: { state: 'running', url: 'http://127.0.0.1:8000', error: null },
    };
    const localModel: LocalModelStatus = {
      embedding: { state: 'running', url: 'http://127.0.0.1:12345', error: null },
      rerank: { state: 'idle', url: null, error: null },
    };

    render(
      <ServiceStatusPanel
        daemon={daemon}
        localModel={localModel}
        loading={false}
        error={null}
      />
    );

    expect(screen.getByText('http://127.0.0.1:8000')).toBeTruthy();
    expect(screen.getByText('http://127.0.0.1:12345')).toBeTruthy();
  });
});
