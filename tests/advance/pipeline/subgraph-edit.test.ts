import { describe, expect, it } from 'vitest';
import {
  getDrillDefinition,
  materializeRoleSubgraph,
  updateDrillDefinition,
} from '../../../src/electron/renderer/components/pipeline-edit.js';
import { parseAstGrepOutput } from '../../../src/advance/ast-grep/runner.js';
import type { PipelineDefinitionDto } from '../../../src/electron/shared/types.js';

describe('钻取层编辑助手', () => {
  function makeRoot(): PipelineDefinitionDto {
    return {
      version: 1,
      id: 'root',
      nodes: [
        {
          id: 'role-reviewer',
          type: 'role.reviewer',
          params: {},
          subgraph: materializeRoleSubgraph('role-reviewer', 'role.reviewer'),
        },
      ],
      edges: [],
    };
  }

  it('getDrillDefinition 沿路径下钻，空路径返回根', () => {
    const root = makeRoot();
    expect(getDrillDefinition(root, [])).toBe(root);
    const sub = getDrillDefinition(root, ['role-reviewer']);
    expect(sub?.id).toBe('role-reviewer-subgraph');
    expect(sub?.nodes.map(n => n.type)).toEqual(['stage.ast-grep', 'stage.role-run']);
    expect(getDrillDefinition(root, ['ghost'])).toBeNull();
  });

  it('updateDrillDefinition 编辑子图并映射回根定义', () => {
    const root = makeRoot();
    const sub = getDrillDefinition(root, ['role-reviewer'])!;
    const edited = { ...sub, nodes: [...sub.nodes, { id: 's3', type: 'stage.x', params: {} }] };
    const newRoot = updateDrillDefinition(root, ['role-reviewer'], edited);
    expect(newRoot.nodes[0].subgraph?.nodes).toHaveLength(3);
    // 原定义不被修改（不可变更新）
    expect(root.nodes[0].subgraph?.nodes).toHaveLength(2);
  });

  it('materializeRoleSubgraph：非 reviewer 只含复合 stage', () => {
    const sub = materializeRoleSubgraph('role-maintainer', 'role.maintainer');
    expect(sub.nodes).toHaveLength(1);
    expect(sub.nodes[0].type).toBe('stage.role-run');
  });
});

describe('ast-grep 输出解析', () => {
  it('解析数组形态输出', () => {
    const output = JSON.stringify([
      {
        file: 'src/a.ts',
        rules: [{ line: 3, column: 5, id: 'no-eval', message: '禁用 eval', severity: 'error' }],
      },
    ]);
    const findings = parseAstGrepOutput(output);
    expect(findings).toEqual([
      {
        file: 'src/a.ts',
        line: 3,
        column: 5,
        ruleId: 'no-eval',
        message: '禁用 eval',
        severity: 'error',
      },
    ]);
  });

  it('兼容 {results} 包装与垃圾输入', () => {
    expect(parseAstGrepOutput(JSON.stringify({ results: [] }))).toEqual([]);
    expect(parseAstGrepOutput('不是 JSON')).toEqual([]);
    expect(parseAstGrepOutput('')).toEqual([]);
  });
});
