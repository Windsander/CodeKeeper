import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildMrAgentEnv,
  type MrAgentEnv,
} from '../../../src/advance/classic/classic-config-builder';
import {
  loadConfigFromEnv,
} from '../../../src/advance/classic/agent-entries/role-entry';
import type { Project } from '../../../src/advance/types';

/**
 * 构造测试用的 Project 对象
 */
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: '/path/to/project',
    rootPath: '/path/to/project',
    name: 'test-project',
    registeredAt: Date.now(),
    lastScannedAt: null,
    ...overrides,
  };
}

const daemonConfig = {
  apiKey: 'sk-test-key',
  provider: 'openai',
  model: 'gpt-4o',
  apiUrl: 'https://api.openai.com/v1',
  headers: '{"X-Custom": "header"}',
};

describe('buildMrAgentEnv', () => {
  it('应过滤出启用了 MR 评审且配置了 GitLab 的项目', () => {
    const projectWithMr: Project = makeProject({
      id: '/path/with-mr',
      name: 'with-mr',
      gitlab: {
        baseUrl: 'https://git.example.com',
        projectPath: 'group/with-mr',
        token: 'token1',
      },
      mrReview: {
        enabled: true,
        autoMergeMode: 'audit',
        reviewSchedule: '0 9 * * 1-5',
        learningEnabled: false,
        maxAutoMergeRisk: 'MEDIUM',
      },
    });

    const projectNoGitlab: Project = makeProject({
      id: '/path/no-gitlab',
      name: 'no-gitlab',
      mrReview: {
        enabled: true,
        autoMergeMode: 'audit',
        reviewSchedule: '0 9 * * 1-5',
        learningEnabled: false,
        maxAutoMergeRisk: 'MEDIUM',
      },
    });

    const projectNoMr: Project = makeProject({
      id: '/path/no-mr',
      name: 'no-mr',
      gitlab: {
        baseUrl: 'https://git.example.com',
        projectPath: 'group/no-mr',
        token: 'token2',
      },
      mrReview: {
        enabled: false,
        autoMergeMode: 'audit',
        reviewSchedule: '0 9 * * 1-5',
        learningEnabled: false,
        maxAutoMergeRisk: 'MEDIUM',
      },
    });

    const projectDisabled: Project = makeProject({
      id: '/path/disabled',
      name: 'disabled',
      gitlab: {
        baseUrl: 'https://git.example.com',
        projectPath: 'group/disabled',
        token: 'token3',
      },
      mrReview: {
        enabled: false,
        autoMergeMode: 'audit',
        reviewSchedule: '0 9 * * 1-5',
        learningEnabled: false,
        maxAutoMergeRisk: 'MEDIUM',
      },
    });

    const env = buildMrAgentEnv(
      [projectWithMr, projectNoGitlab, projectNoMr, projectDisabled],
      daemonConfig
    );

    // 只有同时满足 mrReview.enabled && gitlab 的项目才被保留
    const parsedProjects = JSON.parse(env.CK_PROJECTS_JSON) as Project[];
    expect(parsedProjects).toHaveLength(1);
    expect(parsedProjects[0].id).toBe('/path/with-mr');
    expect(parsedProjects[0].name).toBe('with-mr');
  });

  it('应正确序列化 LLM 配置到环境变量', () => {
    const project: Project = makeProject({
      id: '/path/only',
      name: 'only',
      gitlab: {
        baseUrl: 'https://git.example.com',
        projectPath: 'group/only',
        token: 'token',
      },
      mrReview: {
        enabled: true,
        autoMergeMode: 'full',
        reviewSchedule: '0 */6 * * *',
        learningEnabled: true,
        maxAutoMergeRisk: 'LOW',
      },
    });

    const env = buildMrAgentEnv([project], daemonConfig);

    expect(env.CK_LLM_API_KEY).toBe('sk-test-key');
    expect(env.CK_LLM_PROVIDER).toBe('openai');
    expect(env.CK_LLM_MODEL).toBe('gpt-4o');
    expect(env.CK_LLM_API_URL).toBe('https://api.openai.com/v1');
    expect(env.CK_LLM_HEADERS).toBe('{"X-Custom": "header"}');
  });

  it('空项目列表时应返回空数组 JSON', () => {
    const env = buildMrAgentEnv([], daemonConfig);
    expect(env.CK_PROJECTS_JSON).toBe('[]');
  });

  it('应保留项目完整字段（包括 gitlab 和 mrReview 配置）', () => {
    const project: Project = makeProject({
      id: '/path/full',
      name: 'full-project',
      gitlab: {
        baseUrl: 'https://git.example.com',
        projectPath: 'group/full',
        token: 'glpat-xxx',
        defaultBranch: 'develop',
      },
      mrReview: {
        enabled: true,
        autoMergeMode: 'full',
        reviewSchedule: '0 9 * * 1-5',
        learningEnabled: true,
        maxAutoMergeRisk: 'HIGH',
      },
    });

    const env = buildMrAgentEnv([project], daemonConfig);
    const parsed = JSON.parse(env.CK_PROJECTS_JSON) as Project[];

    expect(parsed[0]).toEqual(project);
  });

  it('多个符合条件的项目应全部保留并保持顺序', () => {
    const projects: Project[] = [
      makeProject({
        id: '/path/a',
        name: 'project-a',
        gitlab: { baseUrl: 'https://a.com', projectPath: 'a', token: 't1' },
        mrReview: {
          enabled: true,
          autoMergeMode: 'audit',
          reviewSchedule: '0 9 * * 1-5',
          learningEnabled: false,
          maxAutoMergeRisk: 'MEDIUM',
        },
      }),
      makeProject({
        id: '/path/b',
        name: 'project-b',
        gitlab: { baseUrl: 'https://b.com', projectPath: 'b', token: 't2' },
        mrReview: {
          enabled: true,
          autoMergeMode: 'full',
          reviewSchedule: '0 */6 * * *',
          learningEnabled: true,
          maxAutoMergeRisk: 'LOW',
        },
      }),
    ];

    const env = buildMrAgentEnv(projects, daemonConfig);
    const parsed = JSON.parse(env.CK_PROJECTS_JSON) as Project[];

    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('/path/a');
    expect(parsed[1].id).toBe('/path/b');
  });
});

describe('loadConfigFromEnv', () => {
  it('应从环境变量正确解析 LLM 配置和项目列表', () => {
    const projects: Project[] = [
      makeProject({
        id: '/path/p1',
        name: 'p1',
        gitlab: { baseUrl: 'https://g.com', projectPath: 'p1', token: 't1' },
        mrReview: {
          enabled: true,
          autoMergeMode: 'audit',
          reviewSchedule: '0 9 * * 1-5',
          learningEnabled: false,
          maxAutoMergeRisk: 'MEDIUM',
        },
      }),
    ];

    const env: NodeJS.ProcessEnv = {
      CK_LLM_API_KEY: 'sk-key',
      CK_LLM_PROVIDER: 'anthropic',
      CK_LLM_MODEL: 'claude-3-5-sonnet',
      CK_LLM_API_URL: 'https://api.anthropic.com',
      CK_LLM_HEADERS: '{"X-Api-Version": "2023-06-01"}',
      CK_PROJECTS_JSON: JSON.stringify(projects),
    };

    const config = loadConfigFromEnv(env);

    expect(config.llm.apiKey).toBe('sk-key');
    expect(config.llm.provider).toBe('anthropic');
    expect(config.llm.model).toBe('claude-3-5-sonnet');
    expect(config.llm.apiUrl).toBe('https://api.anthropic.com');
    expect(config.llm.headers).toBe('{"X-Api-Version": "2023-06-01"}');
    expect(config.projects).toHaveLength(1);
    expect(config.projects[0].name).toBe('p1');
  });

  it('缺少必要环境变量时应抛出错误', () => {
    expect(() => loadConfigFromEnv({})).toThrow(
      '缺少必要的环境变量'
    );
  });

  it('CK_LLM_HEADERS 缺失时应默认使用空对象 JSON', () => {
    const env: NodeJS.ProcessEnv = {
      CK_LLM_API_KEY: 'key',
      CK_LLM_PROVIDER: 'openai',
      CK_LLM_MODEL: 'gpt-4',
      CK_LLM_API_URL: 'https://api.openai.com',
      // CK_LLM_HEADERS 缺失
    };

    const config = loadConfigFromEnv(env);
    expect(config.llm.headers).toBe('{}');
  });

  it('CK_PROJECTS_JSON 缺失时应返回空数组', () => {
    const env: NodeJS.ProcessEnv = {
      CK_LLM_API_KEY: 'key',
      CK_LLM_PROVIDER: 'openai',
      CK_LLM_MODEL: 'gpt-4',
      CK_LLM_API_URL: 'https://api.openai.com',
    };

    const config = loadConfigFromEnv(env);
    expect(config.projects).toEqual([]);
  });

  it('CK_PROJECTS_JSON 格式非法时应抛出错误', () => {
    const env: NodeJS.ProcessEnv = {
      CK_LLM_API_KEY: 'key',
      CK_LLM_PROVIDER: 'openai',
      CK_LLM_MODEL: 'gpt-4',
      CK_LLM_API_URL: 'https://api.openai.com',
      CK_PROJECTS_JSON: '不是 json',
    };

    expect(() => loadConfigFromEnv(env)).toThrow(
      'CK_PROJECTS_JSON 解析失败'
    );
  });
});
