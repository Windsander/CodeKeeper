import { describe, expect, it } from 'vitest';
import {
  addEdgeToDefinition,
  addNodeToDefinition,
  defaultInPort,
  defaultOutPort,
  deleteEdgesFromDefinition,
  deleteNodesFromDefinition,
  moveAllNodesInDefinition,
  updateNodeInDefinition,
} from '../../../src/electron/renderer/components/pipeline-edit.js';
import type { PipelineDefinitionDto } from '../../../src/electron/shared/types.js';

function makeDef(): PipelineDefinitionDto {
  return {
    version: 1,
    id: 'p1',
    nodes: [
      { id: 't1', type: 'trigger.cron', params: { schedule: '*/10 * * * *' } },
      { id: 'r1', type: 'role.reviewer', params: {} },
      { id: 'm1', type: 'role.maintainer', params: {} },
    ],
    edges: [
      {
        id: 'e1',
        from: { node: 't1', port: 'tick' },
        to: { node: 'r1', port: 'trigger' },
        channel: 'memory',
      },
    ],
  };
}

describe('管线画布编辑操作', () => {
  it('端口映射：trigger.cron 出 tick，role.* 入 trigger', () => {
    expect(defaultOutPort('trigger.cron')).toBe('tick');
    expect(defaultOutPort('role.reviewer')).toBe('out');
    expect(defaultInPort('role.maintainer')).toBe('trigger');
    expect(defaultInPort('trigger.cron')).toBe('in');
  });

  it('addEdge 使用类型推断端口且幂等', () => {
    const def = makeDef();
    const withEdge = addEdgeToDefinition(def, 't1', 'm1');
    expect(withEdge.edges).toHaveLength(2);
    expect(withEdge.edges[1]).toMatchObject({
      from: { node: 't1', port: 'tick' },
      to: { node: 'm1', port: 'trigger' },
      channel: 'memory',
    });
    // 重复添加同一条边不改变定义
    expect(addEdgeToDefinition(withEdge, 't1', 'm1').edges).toHaveLength(2);
    // 不存在的节点安全返回
    expect(addEdgeToDefinition(def, 'ghost', 'm1').edges).toHaveLength(1);
  });

  it('deleteNodes 级联删除关联边', () => {
    const def = makeDef();
    const result = deleteNodesFromDefinition(def, ['r1']);
    expect(result.nodes.map(n => n.id)).toEqual(['t1', 'm1']);
    expect(result.edges).toHaveLength(0);
  });

  it('deleteEdges 按 id 与渲染序索引匹配', () => {
    const def = makeDef();
    expect(deleteEdgesFromDefinition(def, ['e1']).edges).toHaveLength(0);
    // 无 id 的边按 edge-${index} 匹配
    const noId = makeDef();
    delete (noId.edges[0] as { id?: string }).id;
    expect(deleteEdgesFromDefinition(noId, ['edge-0']).edges).toHaveLength(0);
  });

  it('addNode / updateNode / moveAllNodes', () => {
    const def = makeDef();
    const added = addNodeToDefinition(def, 'role.archiver', 'Archiver 角色');
    expect(added.nodes).toHaveLength(4);
    expect(added.nodes[3].type).toBe('role.archiver');
    // 同毫秒连续添加两次，id 不碰撞
    const twice = addNodeToDefinition(added, 'role.archiver', 'Archiver 角色');
    const ids = twice.nodes.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);

    const updated = updateNodeInDefinition(twice, {
      id: 't1',
      type: 'trigger.cron',
      params: { schedule: '0 1 * * *' },
      label: '夜间触发',
    });
    expect(updated.nodes[0].label).toBe('夜间触发');
    expect(updated.nodes[0].params.schedule).toBe('0 1 * * *');

    // 一次性固化全部节点坐标（拖单节点等效全量转自由布局）
    const moved = moveAllNodesInDefinition(updated, {
      t1: { x: 100, y: 50 },
      r1: { x: 300, y: 50 },
      m1: { x: 300, y: 200 },
    });
    expect(moved.nodes[0].position).toEqual({ x: 100, y: 50 });
    expect(moved.nodes.find(n => n.id === 'r1')!.position).toEqual({ x: 300, y: 50 });
    // 未出现在坐标表中的节点保持无坐标
    expect(moved.nodes[3].position).toBeUndefined();
  });
});
