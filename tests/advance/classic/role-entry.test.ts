import { describe, it, expect } from 'vitest';
import { loadConfigFromEnv } from '../../../src/advance/classic/agent-entries/role-entry';

const LLM_ENV = {
  CK_LLM_API_KEY: 'sk-key',
  CK_LLM_PROVIDER: 'anthropic',
  CK_LLM_MODEL: 'claude-3-5-sonnet',
  CK_LLM_API_URL: 'https://api.anthropic.com',
};

describe('loadConfigFromEnv', () => {
  it('应从环境变量正确解析角色、项目与 LLM 配置', () => {
    const config = loadConfigFromEnv({
      ROLE: 'reviewer',
      CK_PROJECT_ID: 'proj-1',
      CK_DB_PATH: '/virtual/db.sqlite',
      CK_LLM_HEADERS: '{"X-Api-Version": "2023-06-01"}',
      ...LLM_ENV,
    });

    expect(config.role).toBe('reviewer');
    expect(config.projectId).toBe('proj-1');
    expect(config.dbPath).toBe('/virtual/db.sqlite');
    expect(config.llm.apiKey).toBe('sk-key');
    expect(config.llm.provider).toBe('anthropic');
    expect(config.llm.model).toBe('claude-3-5-sonnet');
    expect(config.llm.apiUrl).toBe('https://api.anthropic.com');
    expect(config.llm.headers).toBe('{"X-Api-Version": "2023-06-01"}');
  });

  it('缺少 ROLE 时应抛出错误', () => {
    expect(() =>
      loadConfigFromEnv({ CK_PROJECT_ID: 'p', CK_DB_PATH: '/virtual/db.sqlite', ...LLM_ENV })
    ).toThrow('缺少 ROLE 环境变量');
  });

  it('缺少 CK_PROJECT_ID 时应抛出错误', () => {
    expect(() =>
      loadConfigFromEnv({ ROLE: 'reviewer', CK_DB_PATH: '/virtual/db.sqlite', ...LLM_ENV })
    ).toThrow('缺少 CK_PROJECT_ID 环境变量');
  });

  it('缺少 CK_DB_PATH 时应抛出错误', () => {
    expect(() => loadConfigFromEnv({ ROLE: 'reviewer', CK_PROJECT_ID: 'p', ...LLM_ENV })).toThrow(
      '缺少 CK_DB_PATH 环境变量'
    );
  });

  it('缺少 LLM 必要变量时应抛出错误', () => {
    expect(() =>
      loadConfigFromEnv({ ROLE: 'reviewer', CK_PROJECT_ID: 'p', CK_DB_PATH: '/virtual/db.sqlite' })
    ).toThrow('缺少必要的环境变量');
  });

  it('CK_LLM_HEADERS 缺失时应默认使用空对象 JSON', () => {
    const config = loadConfigFromEnv({
      ROLE: 'reviewer',
      CK_PROJECT_ID: 'p',
      CK_DB_PATH: '/virtual/db.sqlite',
      ...LLM_ENV,
    });
    expect(config.llm.headers).toBe('{}');
  });
});
