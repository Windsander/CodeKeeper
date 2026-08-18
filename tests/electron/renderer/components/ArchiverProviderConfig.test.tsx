import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiverProviderConfig } from '../../../../src/electron/renderer/components/ArchiverProviderConfig.js';
import type {
  ArchiverConfig,
  ArchiverProviderDescriptor,
  Project,
} from '../../../../src/electron/shared/types.js';

const mockInvoke = vi.fn();
const mockOpenExternal = vi.fn();

const catalog = {
  providers: [
    {
      id: 'graphify',
      displayName: 'Graphify',
      description: '代码结构 Provider',
      homepage: 'https://provider.example/graphify',
      license: 'Apache-2.0',
      kind: 'cli',
      automation: 'full',
      placements: ['primary', 'fallback', 'enricher'],
      capabilities: ['code-structure', 'documents', 'query', 'impact-analysis'],
    },
    {
      id: 'codebase-memory-mcp',
      displayName: 'codebase-memory-mcp',
      description: '代码结构回退 Provider',
      homepage: 'https://provider.example/codebase-memory',
      license: 'MIT',
      kind: 'cli',
      automation: 'full',
      placements: ['primary', 'fallback', 'enricher'],
      capabilities: ['code-structure', 'query', 'impact-analysis'],
    },
    {
      id: 'repowise',
      displayName: 'Repowise',
      description: '补充 Git 历史、影响分析与代码健康度。',
      homepage: 'https://provider.example/repowise',
      license: 'AGPL-3.0-or-later',
      kind: 'cli',
      automation: 'managed',
      placements: ['enricher'],
      capabilities: ['query', 'impact-analysis', 'git-history', 'code-health'],
    },
    {
      id: 'builtin',
      displayName: '内置知识提炼',
      description: '提炼项目文档、约定和维护风险。',
      homepage: '',
      license: 'MIT',
      kind: 'builtin',
      automation: 'full',
      placements: ['primary', 'fallback', 'enricher'],
      capabilities: ['documents', 'query'],
    },
  ] satisfies ArchiverProviderDescriptor[],
};

const initialConfig: ArchiverConfig = {
  role: 'archiver',
  schemaVersion: 3,
  archiverName: 'Archiver',
  automation: {
    enabled: true,
    cron: '0 2 * * *',
  },
};

const project: Project = {
  id: 'project-test',
  name: 'project-test',
  rootPath: 'virtual-workspace/project-test',
};

beforeEach(() => {
  mockInvoke.mockReset();
  mockOpenExternal.mockReset();
  mockInvoke.mockImplementation(async (method: string) => {
    switch (method) {
      case 'project.role.config.get':
        return { config: initialConfig };
      case 'archiver.provider.catalog':
        return catalog;
      case 'archiver.provider.probe':
        return {
          providers: [
            {
              providerId: 'builtin',
              available: true,
              readiness: 'ready',
              prepared: true,
              version: 'built-in',
            },
            {
              providerId: 'graphify',
              available: true,
              readiness: 'ready',
              prepared: false,
              version: '1.2.0',
            },
            {
              providerId: 'codebase-memory-mcp',
              available: false,
              readiness: 'preparable',
              prepared: false,
              message: '系统可自动准备该 Provider。',
            },
            {
              providerId: 'repowise',
              available: true,
              readiness: 'ready',
              prepared: false,
              version: '0.9.0',
            },
          ],
        };
      case 'archiver.provider.status':
        return { status: null };
      case 'project.role.config.update':
        return { success: true };
      default:
        throw new Error(`未 mock 的方法: ${method}`);
    }
  });
  window.electronAPI = {
    invoke: mockInvoke,
    onPush: vi.fn(() => () => {}),
    openExternal: mockOpenExternal,
    showOpenDialog: vi.fn(),
    windowMinimize: vi.fn(),
    windowMaximize: vi.fn(),
    windowClose: vi.fn(),
    onWindowStateChange: vi.fn(() => () => {}),
  } as unknown as Window['electronAPI'];
});

async function renderConfig(onSaved = vi.fn()) {
  render(<ArchiverProviderConfig project={project} onSaved={onSaved} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  await screen.findByText('自动知识方案');
  return onSaved;
}

function lastUpdate(): ArchiverConfig {
  const call = [...mockInvoke.mock.calls]
    .reverse()
    .find(([method]) => method === 'project.role.config.update');
  if (!call) throw new Error('未找到配置保存调用');
  return (call[1] as { config: ArchiverConfig }).config;
}

describe('ArchiverProviderConfig', () => {
  it('只展示身份、运行频率和自动 Provider 诊断', async () => {
    await renderConfig();

    expect(screen.getByText('Archiver 身份')).toBeTruthy();
    expect(screen.getByText('自动归档')).toBeTruthy();
    expect(screen.getByText('自动知识方案')).toBeTruthy();
    expect(screen.getByText('系统自动遴选知识源')).toBeTruthy();
    expect(screen.getByText(/交互式 Skill 只自动准备资源/)).toBeTruthy();
    expect(screen.getByText('每天 02:00')).toBeTruthy();
    expect(screen.getByText('Provider 诊断')).toBeTruthy();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);

    for (const hiddenLabel of [
      '推荐组合',
      '仅内置知识',
      '自定义组合',
      '启动方式',
      '可执行文件覆盖',
      '参数前缀覆盖',
      '显式继承环境变量',
      '环境变量覆盖',
      '超时（秒）',
      'Provider Shell',
    ]) {
      expect(screen.queryByText(hiddenLabel)).toBeNull();
    }
  });

  it('保存身份与自定义 cron 时不写入任何 Provider 字段', async () => {
    const onSaved = await renderConfig();
    fireEvent.change(screen.getByLabelText('Archiver 名称'), {
      target: { value: '项目知识维护者' },
    });

    fireEvent.click(screen.getByRole('button', { name: '每天 02:00' }));
    fireEvent.click(screen.getByText('自定义 cron', { selector: '.dropdown-item' }));
    fireEvent.change(screen.getByLabelText('cron 表达式'), {
      target: { value: '15 */4 * * *' },
    });
    expect(screen.getByText(/旧记忆不会自动迁移/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        'project.role.config.update',
        expect.objectContaining({ projectId: project.id, role: 'archiver' })
      )
    );

    expect(lastUpdate()).toEqual({
      role: 'archiver',
      schemaVersion: 3,
      archiverName: '项目知识维护者',
      automation: { enabled: true, cron: '15 */4 * * *' },
    });
    expect(lastUpdate()).not.toHaveProperty('knowledge');
    expect(lastUpdate()).not.toHaveProperty('providers');
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('诊断区只显示摘要，不展示 Provider 错误消息或执行路径', async () => {
    await renderConfig();

    await waitFor(() => expect(screen.getByText(/版本：1\.2\.0/)).toBeTruthy());
    expect(screen.getAllByText('可用').length).toBeGreaterThan(0);
    expect(screen.getByText('可自动准备')).toBeTruthy();
    expect(screen.queryByText('未安装')).toBeNull();
    expect(screen.queryByText(/执行路径|executable|绝对路径/i)).toBeNull();
  });
});
