import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ArchiverRunner,
  buildArchiverMemoryContext,
  buildArchiverSourceFingerprint,
  isArchiverScanEntryExcluded,
  isPathInside,
} from '../../../../src/advance/classic/runners/archiver-runner.js';
import type { ArchiverProviderOrchestrator } from '../../../../src/advance/archiver/provider-orchestrator.js';
import { createDefaultArchiverConfig } from '../../../../src/advance/archiver/provider-config.js';
import type { LlmClient } from '../../../../src/advance/llm/client.js';
import type { ArchiverConfig, Project } from '../../../../src/advance/types.js';
import { buildEverOSAgentId } from '../../../../src/advance/classic/memory/types.js';

class TestArchiverRunner extends ArchiverRunner {
  runForTest(project: Project, config: ArchiverConfig): Promise<void> {
    return this.runProject(project, config);
  }
}

describe('buildArchiverSourceFingerprint', () => {
  it('文件列表顺序变化时保持稳定', () => {
    const contents = {
      'virtual/module-a.ts': 'export const moduleA = true;',
      'virtual/module-b.ts': 'export const moduleB = true;',
    };

    const first = buildArchiverSourceFingerprint(
      ['virtual/module-a.ts', 'virtual/module-b.ts'],
      contents
    );
    const second = buildArchiverSourceFingerprint(
      ['virtual/module-b.ts', 'virtual/module-a.ts'],
      contents
    );

    expect(second).toBe(first);
  });

  it('文件名不变但内容变化时生成新指纹', () => {
    const sourceFiles = ['virtual/module-a.ts'];
    const first = buildArchiverSourceFingerprint(sourceFiles, {
      'virtual/module-a.ts': 'export const version = 1;',
    });
    const second = buildArchiverSourceFingerprint(sourceFiles, {
      'virtual/module-a.ts': 'export const version = 2;',
    });

    expect(second).not.toBe(first);
  });
});

describe('isArchiverScanEntryExcluded', () => {
  it('排除依赖、归档和 Provider 生成物', () => {
    for (const directory of [
      'node_modules',
      '.git',
      '.codekeeper',
      'dist',
      '.repowise',
      '.codebase-memory',
      'graphify-out',
    ]) {
      expect(isArchiverScanEntryExcluded(directory, true)).toBe(true);
    }
    expect(isArchiverScanEntryExcluded('.graphify_detect.json', false)).toBe(true);
  });

  it('保留普通虚拟源码目录和文件', () => {
    expect(isArchiverScanEntryExcluded('virtual-src', true)).toBe(false);
    expect(isArchiverScanEntryExcluded('virtual-module.ts', false)).toBe(false);
  });
});

describe('ArchiverRunner 自动 Provider 语义', () => {
  let workspace: string;
  let project: Project;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'archiver-runner-'));
    project = {
      id: 'project-test',
      name: 'project-test',
      rootPath: workspace,
      registeredAt: Date.now(),
      lastScannedAt: null,
    };
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('Provider 编排结果没有主 Provider 时保留错误边界', async () => {
    const providerOrchestrator = {
      syncProject: vi.fn().mockResolvedValue({
        shouldRunBuiltin: false,
        builtinRequired: false,
        report: {
          schemaVersion: 1,
          projectId: project.id,
          generatedAt: Date.now(),
          selectedPrimary: '',
          statuses: [
            {
              providerId: 'graph-provider',
              placement: 'primary',
              state: 'failed',
              startedAt: 1,
              finishedAt: 2,
              message: '同步失败',
            },
          ],
        },
      }),
    } as unknown as ArchiverProviderOrchestrator;
    const runner = new TestArchiverRunner({
      llmClient: { complete: vi.fn() } as unknown as LlmClient,
      mcpUrl: '',
      providerOrchestrator,
    });
    const config = createDefaultArchiverConfig();
    config.automation.enabled = true;

    await expect(runner.runForTest(project, config)).rejects.toThrow(
      'Archiver 未找到可用的主 Provider，且内置安全回退已关闭'
    );
  });

  it('Provider 编排异常时自动回退到内置阶段', async () => {
    const finalizeBuiltin = vi.fn().mockResolvedValue(undefined);
    const providerOrchestrator = {
      syncProject: vi.fn().mockRejectedValue(new Error('Provider 状态写入失败')),
      finalizeBuiltin,
    } as unknown as ArchiverProviderOrchestrator;
    const runner = new TestArchiverRunner({
      llmClient: { complete: vi.fn() } as unknown as LlmClient,
      mcpUrl: '',
      providerOrchestrator,
    });
    const config = createDefaultArchiverConfig();
    config.automation.enabled = true;

    await expect(runner.runForTest(project, config)).resolves.toBeUndefined();
    expect(finalizeBuiltin).toHaveBeenCalledWith(
      project,
      expect.any(String),
      expect.objectContaining({ selectedPrimary: 'builtin' }),
      true,
      '项目无可分析文件，内置阶段已跳过'
    );
  });
});

describe('ArchiverRunner EverOS 身份', () => {
  it('使用 archiverName 构建 Agent ID 与显示名称', () => {
    const context = buildArchiverMemoryContext(
      'project-test',
      '项目知识维护者',
      'archiver-project-test-2026-08-13-0'
    );

    expect(context.agentId).toBe(buildEverOSAgentId('archiver', '项目知识维护者'));
    expect(context.agentDisplayName).toBe('项目知识维护者');
    expect(context.projectId).toBe('project-test');
    expect(context.sessionId).toBe('archiver-project-test-2026-08-13-0');
  });
});

describe('isPathInside', () => {
  it('识别归档目录内部路径', () => {
    expect(
      isPathInside(
        'X:\\virtual-project\\.codekeeper',
        'X:\\virtual-project\\.codekeeper\\providers',
        win32
      )
    ).toBe(true);
    expect(isPathInside('virtual-project/.codekeeper', 'virtual-project/src', posix)).toBe(false);
  });

  it('Windows 跨盘符路径不会被误判为归档目录内部', () => {
    expect(isPathInside('X:\\virtual-archive', 'Y:\\virtual-project\\src', win32)).toBe(false);
  });
});
