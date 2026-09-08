import { describe, expect, it } from 'vitest';
import { topoSort, validateGraph } from '../../../../src/advance/pipeline/core/topology.js';
import {
  PipelineCycleError,
  PipelineDefinitionError,
  type PipelineDefinition,
} from '../../../../src/advance/pipeline/core/types.js';

function node(id: string) {
  return { id, type: 'test.node', params: {} };
}

function edge(fromNode: string, toNode: string) {
  return {
    from: { node: fromNode, port: 'out' },
    to: { node: toNode, port: 'in' },
    channel: 'memory' as const,
  };
}

function def(
  nodes: ReturnType<typeof node>[],
  edges: ReturnType<typeof edge>[]
): PipelineDefinition {
  return { version: 1, id: 'p', nodes, edges };
}

describe('管线拓扑', () => {
  it('菱形 DAG 的拓扑序保证依赖先行', () => {
    // a -> b, a -> c, b -> d, c -> d
    const ordered = topoSort(
      def(
        [node('d'), node('c'), node('b'), node('a')],
        [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]
      )
    );
    const position = new Map(ordered.map((n, i) => [n.id, i]));
    expect(position.get('a')!).toBeLessThan(position.get('b')!);
    expect(position.get('a')!).toBeLessThan(position.get('c')!);
    expect(position.get('b')!).toBeLessThan(position.get('d')!);
    expect(position.get('c')!).toBeLessThan(position.get('d')!);
    expect(ordered).toHaveLength(4);
  });

  it('检测环并报出环节点', () => {
    expect(() => topoSort(def([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')]))).toThrow(
      PipelineCycleError
    );
  });

  it('检测自环', () => {
    expect(() => topoSort(def([node('a')], [edge('a', 'a')]))).toThrow(PipelineCycleError);
  });

  it('拒绝重复节点 id', () => {
    expect(() => validateGraph(def([node('a'), node('a')], []))).toThrow(PipelineDefinitionError);
  });

  it('拒绝引用不存在节点的边', () => {
    try {
      validateGraph(def([node('a')], [edge('a', 'ghost')]));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineDefinitionError);
      expect((error as PipelineDefinitionError).issues.join('\n')).toContain('ghost');
    }
  });
});
