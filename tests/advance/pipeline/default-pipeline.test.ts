import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDefaultPipeline,
  ensurePipelineDefinition,
  loadProjectPipeline,
  regeneratePipelineDefinitionIfGenerated,
  DEFAULT_ROLE_SCHEDULES,
  GENERATED_PIPELINE_MARKER,
} from '../../../src/advance/pipeline/default-pipeline.js';
import type { Project } from '../../../src/advance/types.js';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: '示例项目',
    rootPath: '/virtual/projects/demo',
    roles: {},
    ...overrides,
  } as Project;
}

function enabledRole(schedule?: string) {
  return {
    role: 'reviewer' as const,
    enabled: true,
    reviewSchedule: schedule,
  };
}

describe('buildDefaultPipeline', () => {
  it('为每个启用角色生成 trigger.cron -> role.* 节点对', () => {
    const project = makeProject({
      roles: {
        reviewer: enabledRole(),
        maintainer: { role: 'maintainer', enabled: true },
      } as Project['roles'],
    });
    const def = buildDefaultPipeline(project);

    expect(def.nodes).toHaveLength(4);
    expect(def.edges).toHaveLength(2);
    const reviewerTrigger = def.nodes.find(n => n.id === 'trigger-reviewer')!;
    expect(reviewerTrigger.type).toBe('trigger.cron');
    expect(reviewerTrigger.params.schedule).toBe(DEFAULT_ROLE_SCHEDULES.reviewer);
    const reviewerNode = def.nodes.find(n => n.id === 'role-reviewer')!;
    expect(reviewerNode.type).toBe('role.reviewer');
    expect(
      def.edges.some(e => e.from.node === 'trigger-maintainer' && e.to.node === 'role-maintainer')
    ).toBe(true);
  });

  it('角色配置的 reviewSchedule 覆盖默认调度', () => {
    const project = makeProject({
      roles: { reviewer: enabledRole('0 1 * * *') } as Project['roles'],
    });
    const def = buildDefaultPipeline(project);
    expect(def.nodes.find(n => n.id === 'trigger-reviewer')!.params.schedule).toBe('0 1 * * *');
  });

  it('未启用角色不生成节点；无启用角色时不生成任何节点', () => {
    const project = makeProject({
      roles: {
        reviewer: { role: 'reviewer', enabled: false },
      } as unknown as Project['roles'],
    });
    const def = buildDefaultPipeline(project);
    expect(def.nodes).toHaveLength(0);
    expect(def.edges).toHaveLength(0);
  });

  it('archiver 角色使用 automation.cron 与 automation.enabled', () => {
    const project = makeProject({
      roles: {
        archiver: {
          role: 'archiver',
          automation: { enabled: true, cron: '0 3 * * *' },
        },
      } as unknown as Project['roles'],
    });
    const def = buildDefaultPipeline(project);
    expect(def.nodes.find(n => n.id === 'role-archiver')).toBeDefined();
    expect(def.nodes.find(n => n.id === 'trigger-archiver')!.params.schedule).toBe('0 3 * * *');
  });
});

describe('ensurePipelineDefinition / loadProjectPipeline', () => {
  it('缺失时生成 pipeline.yaml 并可回读', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-pipeline-migrate-'));
    try {
      const project = makeProject({
        rootPath: dir,
        roles: { reviewer: enabledRole('*/5 * * * *') } as Project['roles'],
      });
      const path = ensurePipelineDefinition(project);
      expect(path).toBe(join(dir, '.codekeeper', 'pipeline.yaml'));
      expect(existsSync(path!)).toBe(true);

      const loaded = loadProjectPipeline(project);
      expect(loaded).not.toBeNull();
      expect(loaded!.nodes.map(n => n.id).sort()).toEqual(['role-reviewer', 'trigger-reviewer']);

      // 再次调用不覆盖已有文件
      writeFileSync(path!, '# human edit\n' + readFileSync(path!, 'utf-8'));
      ensurePipelineDefinition(project);
      expect(readFileSync(path!, 'utf-8')).toContain('# human edit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('无启用角色时不生成文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-pipeline-empty-'));
    try {
      const project = makeProject({ rootPath: dir });
      expect(ensurePipelineDefinition(project)).toBeNull();
      expect(existsSync(join(dir, '.codekeeper', 'pipeline.yaml'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('非法 YAML 返回 null 而不抛出', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-pipeline-bad-'));
    try {
      mkdirSync(join(dir, '.codekeeper'), { recursive: true });
      writeFileSync(join(dir, '.codekeeper', 'pipeline.yaml'), 'version: 2\nid: bad\n');
      expect(loadProjectPipeline(makeProject({ rootPath: dir }))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('regeneratePipelineDefinitionIfGenerated', () => {
  function enableWithSchedule(schedule: string): Project {
    return makeProject({
      roles: { reviewer: { role: 'reviewer', enabled: true, reviewSchedule: schedule } },
    } as unknown as Project);
  }

  it('生成件随角色配置更新重建', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-pipeline-regen-'));
    try {
      const project = enableWithSchedule('*/5 * * * *');
      project.rootPath = dir;
      ensurePipelineDefinition(project);

      // 配置变更：调度改为每小时
      const updated = enableWithSchedule('0 * * * *');
      updated.rootPath = dir;
      regeneratePipelineDefinitionIfGenerated(updated);

      const reloaded = loadProjectPipeline(updated);
      expect(reloaded!.nodes.find(n => n.id === 'trigger-reviewer')!.params.schedule).toBe(
        '0 * * * *'
      );
      expect(readFileSync(join(dir, '.codekeeper', 'pipeline.yaml'), 'utf-8')).toContain(
        GENERATED_PIPELINE_MARKER
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('人类编辑过（删除标记）的正本不再回写', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-pipeline-human-'));
    try {
      const project = enableWithSchedule('*/5 * * * *');
      project.rootPath = dir;
      const filePath = ensurePipelineDefinition(project)!;

      // 人类编辑：删除标记并自定义内容
      const humanEdited = readFileSync(filePath, 'utf-8').replace(
        GENERATED_PIPELINE_MARKER + '\n',
        '# 人类编辑过\n'
      );
      writeFileSync(filePath, humanEdited);

      const updated = enableWithSchedule('0 * * * *');
      updated.rootPath = dir;
      regeneratePipelineDefinitionIfGenerated(updated);

      // 文件保持人类编辑后的样子
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('# 人类编辑过');
      expect(content).toContain('*/5 * * * *');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('正本缺失时不创建（由调度链路负责补建）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-pipeline-regen-missing-'));
    try {
      const project = enableWithSchedule('*/5 * * * *');
      project.rootPath = dir;
      regeneratePipelineDefinitionIfGenerated(project);
      expect(existsSync(join(dir, '.codekeeper', 'pipeline.yaml'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
