import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPipelineDefinition,
  parsePipelineDefinition,
} from '../../../../src/advance/pipeline/core/loader.js';
import { PipelineDefinitionError } from '../../../../src/advance/pipeline/core/types.js';

const VALID_YAML = `
version: 1
id: review-pipeline
label: MR 评审管线
nodes:
  - id: trigger
    type: trigger.cron
    params:
      schedule: "*/10 * * * *"
  - id: reviewer
    type: role.reviewer
    position: { x: 120, y: 40 }
  - id: gitlab
    type: sink.gitlab
edges:
  - from: { node: trigger, port: tick }
    to: { node: reviewer, port: trigger }
  - from: { node: reviewer, port: findings }
    to: { node: gitlab, port: findings }
    channel: gitlab-discussion
    artifactType: Findings
`;

describe('管线定义加载与校验', () => {
  it('解析合法定义并填充默认值', () => {
    const def = parsePipelineDefinition(VALID_YAML);
    expect(def.id).toBe('review-pipeline');
    expect(def.nodes).toHaveLength(3);
    expect(def.edges).toHaveLength(2);
    // channel 默认值
    expect(def.edges[0].channel).toBe('memory');
    expect(def.edges[1].channel).toBe('gitlab-discussion');
    // params 默认值
    const reviewer = def.nodes.find(n => n.id === 'reviewer')!;
    expect(reviewer.params).toEqual({});
    expect(reviewer.position).toEqual({ x: 120, y: 40 });
  });

  it('拒绝错误的 version', () => {
    expect(() => parsePipelineDefinition('version: 2\nid: x\nnodes: []\n')).toThrow(
      PipelineDefinitionError
    );
  });

  it('拒绝非法 channel 并聚合 issue 信息', () => {
    const bad = `
version: 1
id: p
nodes:
  - id: a
    type: trigger.cron
edges:
  - from: { node: a, port: out }
    to: { node: a, port: in }
    channel: carrier-pigeon
`;
    try {
      parsePipelineDefinition(bad);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineDefinitionError);
      expect((error as PipelineDefinitionError).issues.join('\n')).toContain('carrier-pigeon');
    }
  });

  it('支持嵌套 subgraph（钻取层预留字段）', () => {
    const nested = `
version: 1
id: p
nodes:
  - id: reviewer
    type: role.reviewer
    subgraph:
      version: 1
      id: reviewer-stages
      nodes:
        - id: scan
          type: stage.scan
      edges: []
`;
    const def = parsePipelineDefinition(nested);
    const reviewer = def.nodes[0];
    expect(reviewer.subgraph?.id).toBe('reviewer-stages');
    expect(reviewer.subgraph?.nodes[0].type).toBe('stage.scan');
  });

  it('从文件加载（临时目录）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-pipeline-loader-'));
    const file = join(dir, 'pipeline.yaml');
    writeFileSync(file, VALID_YAML);
    const def = loadPipelineDefinition(file);
    expect(def.id).toBe('review-pipeline');
  });

  it('文件不存在时抛出 PipelineDefinitionError', () => {
    expect(() => loadPipelineDefinition(join(tmpdir(), 'ck-not-exists-pipeline.yaml'))).toThrow(
      PipelineDefinitionError
    );
  });
});
