import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ServiceStatusPanel } from '../../../../src/electron/renderer/components/ServiceStatusPanel';
import type { DaemonStatus, LocalModelStatus, RemoteModelStatus } from '../../../../src/electron/shared/service-status';

describe('ServiceStatusPanel', () => {
  const defaultRemoteModel: RemoteModelStatus = {
    llm: { state: 'unconfigured', modelLabel: '未配置', fullModel: '', baseUrl: null, error: null, lastCheckedAt: 0 },
    multimodal: { state: 'unconfigured', modelLabel: '未配置', fullModel: '', baseUrl: null, error: null, lastCheckedAt: 0 },
  };

  const defaultCodeGraph: DaemonStatus['codeGraph'] = {
    state: 'running',
    url: 'http://127.0.0.1:7010',
    error: null,
    activeJobs: 0,
    queuedJobs: 0,
    providers: [
      {
        providerId: 'graphify',
        displayName: 'Graphify',
        state: 'ready',
        prepared: true,
        version: '0.9.42',
        message: '托管运行时已就绪',
      },
      {
        providerId: 'understand-anything',
        displayName: 'Understand Anything',
        state: 'manual',
        prepared: true,
        version: '2.9.0',
        message: 'Skill 已准备，等待 Agent 工作流调度',
      },
    ],
  };

  it('渲染记忆、代码图谱与模型服务树形结构', () => {
    const daemon: DaemonStatus = {
      daemonRunning: true,
      everos: { state: 'running', url: 'http://127.0.0.1:8000', error: null },
      codeGraph: defaultCodeGraph,
    };
    const localModel: LocalModelStatus = {
      embedding: { state: 'running', url: 'http://127.0.0.1:12345', error: null, progress: null },
      rerank: { state: 'running', url: 'http://127.0.0.1:12346', error: null, progress: null },
    };

    render(
      <ServiceStatusPanel
        daemon={daemon}
        localModel={localModel}
        remoteModel={defaultRemoteModel}
      />
    );

    expect(screen.getByText('服务状态')).toBeTruthy();
    expect(screen.getByText('Daemon')).toBeTruthy();
    expect(screen.getByText('记忆服务（EverOS）')).toBeTruthy();
    expect(screen.getByText('代码图谱服务')).toBeTruthy();
    expect(screen.getByText('Graphify')).toBeTruthy();
    expect(screen.getByText('Understand Anything')).toBeTruthy();
    expect(screen.getByText('本地模型服务')).toBeTruthy();
    expect(screen.getByText('Embedding')).toBeTruthy();
    expect(screen.getByText('Rerank')).toBeTruthy();
  });

  it('根据状态显示对应颜色 badge', () => {
    const daemon: DaemonStatus = {
      daemonRunning: true,
      everos: { state: 'starting', url: null, error: null },
      codeGraph: defaultCodeGraph,
    };
    const localModel: LocalModelStatus = {
      embedding: { state: 'downloading', url: null, error: null, progress: 30 },
      rerank: { state: 'loading', url: null, error: null, progress: null },
    };

    const { container } = render(
      <ServiceStatusPanel
        daemon={daemon}
        localModel={localModel}
        remoteModel={defaultRemoteModel}
      />
    );

    expect(container.querySelector('.badge-success')?.textContent).toBe('运行中');
    expect(container.querySelector('.badge-info')?.textContent).toBe('启动中');
    expect(within(screen.getByTestId('status-node-embedding')).getByText('下载中')).toBeTruthy();
    expect(container.textContent).toContain('加载中');
  });

  it('downloading 状态显示实际进度条', () => {
    const daemon: DaemonStatus = {
      daemonRunning: true,
      everos: { state: 'running', url: null, error: null },
      codeGraph: defaultCodeGraph,
    };
    const localModel: LocalModelStatus = {
      embedding: { state: 'downloading', url: null, error: null, progress: 30 },
      rerank: { state: 'idle', url: null, error: null, progress: null },
    };

    const { container } = render(
      <ServiceStatusPanel
        daemon={daemon}
        localModel={localModel}
        remoteModel={defaultRemoteModel}
      />
    );

    expect(container.querySelector('.service-status-progress')).toBeTruthy();
  });

  it('running 状态不显示进度条', () => {
    const daemon: DaemonStatus = {
      daemonRunning: true,
      everos: { state: 'running', url: null, error: null },
      codeGraph: defaultCodeGraph,
    };
    const localModel: LocalModelStatus = {
      embedding: { state: 'running', url: 'http://127.0.0.1:12345', error: null, progress: null },
      rerank: { state: 'running', url: 'http://127.0.0.1:12346', error: null, progress: null },
    };

    const { container } = render(
      <ServiceStatusPanel
        daemon={daemon}
        localModel={localModel}
        remoteModel={defaultRemoteModel}
      />
    );

    expect(container.querySelector('.service-status-progress')).toBeNull();
  });

  it('错误状态可点击展开，显示截断错误摘要', () => {
    const longError = 'a'.repeat(300);
    const daemon: DaemonStatus = {
      daemonRunning: true,
      everos: { state: 'error', url: null, error: longError },
      codeGraph: defaultCodeGraph,
    };
    const localModel: LocalModelStatus = {
      embedding: { state: 'error', url: null, error: 'embedding 启动失败', progress: null },
      rerank: { state: 'idle', url: null, error: null, progress: null },
    };

    render(
      <ServiceStatusPanel
        daemon={daemon}
        localModel={localModel}
        remoteModel={defaultRemoteModel}
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
      codeGraph: defaultCodeGraph,
    };
    const localModel: LocalModelStatus = {
      embedding: { state: 'running', url: 'http://127.0.0.1:12345', error: null, progress: null },
      rerank: { state: 'idle', url: null, error: null, progress: null },
    };
    const remoteModel: RemoteModelStatus = {
      llm: { state: 'running', modelLabel: 'Claude', fullModel: 'claude-3-5-sonnet', baseUrl: 'https://api.anthropic.com/v1', error: null, lastCheckedAt: Date.now() },
      multimodal: { state: 'running', modelLabel: 'GPT-4o', fullModel: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', error: null, lastCheckedAt: Date.now() },
    };

    render(
      <ServiceStatusPanel
        daemon={daemon}
        localModel={localModel}
        remoteModel={remoteModel}
      />
    );

    expect(screen.getByText('http://127.0.0.1:8000')).toBeTruthy();
    expect(screen.getByText('http://127.0.0.1:7010')).toBeTruthy();
    expect(screen.getByText('http://127.0.0.1:12345')).toBeTruthy();
    expect(screen.getByText('https://api.anthropic.com/v1')).toBeTruthy();
    expect(screen.getByText('https://api.openai.com/v1')).toBeTruthy();
  });

});
