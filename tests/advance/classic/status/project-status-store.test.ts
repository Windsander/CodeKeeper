/**
 * project-status-store 单元测试
 *
 * 状态文件存放在应用存储空间的项目代理目录中。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadProjectStatus,
  saveProjectStatus,
  recordProjectError,
  clearProjectError,
  recordAgentStarted,
  recordAgentStopped,
} from '../../../../src/advance/classic/status/project-status-store.js';
import { getProjectAgentStatusDir } from '../../../../src/core/platform.js';
import type { Project } from '../../../../src/advance/types.js';

const TEST_PROJECT_NAME = `ck-status-test-${Date.now()}`;

function makeProject(): Project {
  return {
    id: `test-${TEST_PROJECT_NAME}`,
    name: TEST_PROJECT_NAME,
    rootPath: 'virtual-project/status',
    registeredAt: Date.now(),
    lastScannedAt: null,
  };
}

function getTestStatusDir(): string {
  return getProjectAgentStatusDir(TEST_PROJECT_NAME);
}

describe('project-status-store', () => {
  beforeEach(() => {
    const dir = getTestStatusDir();
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    rmSync(getTestStatusDir(), { recursive: true, force: true });
  });

  it('未保存时返回空状态', () => {
    const project = makeProject();
    expect(loadProjectStatus(project)).toEqual({});
  });

  it('保存后读取应一致', () => {
    const project = makeProject();
    const status = {
      lastError: {
        type: 'invalid-token' as const,
        message: 'Token 失效',
        at: Date.now(),
      },
      lastSuccessAt: Date.now() - 1000,
    };
    saveProjectStatus(project, status);
    expect(loadProjectStatus(project)).toEqual(status);
  });

  it('支持显式覆盖错误类型', () => {
    const project = makeProject();
    recordProjectError(project, new Error('连接超时'), 'missing-token');
    const status = loadProjectStatus(project);
    expect(status.lastError?.type).toBe('missing-token');
  });

  it('记录 missing-token 错误', () => {
    const project = makeProject();
    recordProjectError(project, new Error('GitLab API 401: Unauthorized'));
    const status = loadProjectStatus(project);
    expect(status.lastError?.type).toBe('invalid-token');
    expect(status.lastError?.message).toContain('401');
  });

  it('记录 gitlab-api 错误', () => {
    const project = makeProject();
    recordProjectError(project, new Error('GitLab API 500: Internal Server Error'));
    const status = loadProjectStatus(project);
    expect(status.lastError?.type).toBe('gitlab-api');
  });

  it('记录 unknown 错误', () => {
    const project = makeProject();
    recordProjectError(project, new Error('连接超时'));
    const status = loadProjectStatus(project);
    expect(status.lastError?.type).toBe('unknown');
  });

  it('清除错误并记录成功时间', () => {
    const project = makeProject();
    recordProjectError(project, new Error('GitLab API 401'));
    clearProjectError(project);
    const status = loadProjectStatus(project);
    expect(status.lastError).toBeUndefined();
    expect(status.lastSuccessAt).toBeDefined();
  });

  it('记录 Agent 启动与停止时间', () => {
    const project = makeProject();
    recordAgentStarted(project);
    let status = loadProjectStatus(project);
    expect(status.agentStartedAt).toBeDefined();
    expect(status.agentStoppedAt).toBeUndefined();

    recordAgentStopped(project);
    status = loadProjectStatus(project);
    expect(status.agentStoppedAt).toBeDefined();
  });

  it('状态文件损坏时返回空对象', () => {
    const project = makeProject();
    const dir = getTestStatusDir();
    const path = join(dir, 'mr-agent-project-status.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, 'not-json', 'utf-8');
    expect(loadProjectStatus(project)).toEqual({});
  });
});
