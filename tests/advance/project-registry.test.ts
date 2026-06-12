import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetadataStore } from '../../src/advance/store/metadata-store';
import { ProjectRegistry } from '../../src/advance/project-registry';

describe('ProjectRegistry', () => {
  let store: MetadataStore;
  let registry: ProjectRegistry;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-reg-'));
    store = new MetadataStore(join(dir, 'test.db'));
    registry = new ProjectRegistry({ store });
  });

  afterEach(() => {
    store.close();
  });

  it('注册项目时生成稳定 ID', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-proj-'));
    const project = registry.register(dir);
    expect(project.rootPath).toBe(dir);
    expect(project.id).toHaveLength(16);
    expect(registry.list()).toHaveLength(1);
  });

  it('读取项目自定义名称', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-proj-'));
    mkdirSync(join(dir, '.codekeeper'));
    writeFileSync(join(dir, '.codekeeper', 'config.yaml'), 'name: 自定义名称\n');
    const project = registry.register(dir);
    expect(project.name).toBe('自定义名称');
  });

  it('注销项目后列表为空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-proj-'));
    const project = registry.register(dir);
    registry.unregister(project.id);
    expect(registry.list()).toHaveLength(0);
  });
});
