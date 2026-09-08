import { useCallback, useRef, useState } from 'react';
import type {
  PipelineDefinitionDto,
  PipelineGetResult,
  PipelineNodeDto,
  PipelineRunDto,
  Project,
} from '../../shared/types.js';
import { useIpc } from '../hooks/useIpc.js';
import { invoke } from '../api/electron-api.js';
import { PipelineGraph } from './PipelineGraph.js';
import { RoleProjectConfig } from './RoleProjectConfig.js';
import {
  addEdgeToDefinition,
  addNodeToDefinition,
  deleteEdgesFromDefinition,
  deleteNodesFromDefinition,
  moveAllNodesInDefinition,
  NODE_PALETTE,
  updateNodeInDefinition,
} from './pipeline-edit.js';

/** 草稿缓存：tab 切换/组件卸载时保留未保存编辑（按项目隔离） */
const draftCache = new Map<string, PipelineDefinitionDto>();

interface PipelineCanvasProps {
  projectId: string;
}

/**
 * 项目管线画布页：渲染/编辑 pipeline.yaml，叠加运行状态。
 * 保存即写回 YAML 并热加载；保存后正本转为人类正本（不再随角色配置自动重建）。
 */
export function PipelineCanvas({ projectId }: PipelineCanvasProps) {
  const { data: pipeline, refresh } = useIpc<PipelineGetResult>('pipeline.get', { projectId });
  const { data: project } = useIpc<Project>('project.get', { projectId });
  const { data: runs } = useIpc<PipelineRunDto[]>(
    'pipeline.runs',
    { projectId, limit: 10 },
    { pollInterval: 5000 }
  );

  const [draft, setDraftState] = useState<PipelineDefinitionDto | null>(
    () => draftCache.get(projectId) ?? null
  );
  // 草稿写入模块级缓存，组件重挂载（tab 切换）后可恢复
  const setDraft = (
    value:
      | PipelineDefinitionDto
      | null
      | ((prev: PipelineDefinitionDto | null) => PipelineDefinitionDto | null)
  ) => {
    setDraftState(prev => {
      const next = typeof value === 'function' ? value(prev) : value;
      if (next) draftCache.set(projectId, next);
      else draftCache.delete(projectId);
      return next;
    });
  };
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 编辑态：有未保存草稿时用草稿，否则用正本
  const pipelineDefRef = useRef<PipelineDefinitionDto | null>(null);
  pipelineDefRef.current = pipeline?.definition ?? null;
  const definition = draft ?? pipelineDefRef.current;
  const dirty = draft !== null;

  const mutate = useCallback((fn: (def: PipelineDefinitionDto) => PipelineDefinitionDto) => {
    setDraft(prev => {
      const base = prev ?? pipelineDefRef.current;
      return base ? fn(base) : prev;
    });
  }, []);

  const handleSelectNode = useCallback((nodeId: string | null) => setSelectedNodeId(nodeId), []);

  const handleMoveAllNodes = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      mutate(def => moveAllNodesInDefinition(def, positions));
    },
    [mutate]
  );

  const handleAddEdge = useCallback(
    (fromNodeId: string, toNodeId: string) => {
      mutate(def => addEdgeToDefinition(def, fromNodeId, toNodeId));
    },
    [mutate]
  );

  const handleDeleteNodes = useCallback(
    (nodeIds: string[]) => {
      mutate(def => deleteNodesFromDefinition(def, nodeIds));
      setSelectedNodeId(null);
    },
    [mutate]
  );

  const handleDeleteEdges = useCallback(
    (edgeIds: string[]) => {
      mutate(def => deleteEdgesFromDefinition(def, edgeIds));
    },
    [mutate]
  );

  const addNode = useCallback(
    (type: string, label: string) => {
      mutate(def => addNodeToDefinition(def, type, label));
    },
    [mutate]
  );

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      await invoke('pipeline.update', { projectId, definition: draft });
      setDraft(null);
      refresh();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [draft, projectId, refresh]);

  const discard = useCallback(() => {
    setDraft(null);
    setSaveError(null);
  }, []);

  if (!pipeline) return <div className="pipeline-loading">加载管线定义…</div>;
  if (!definition) {
    return <div className="pipeline-empty">项目暂无可调度的角色，请先在角色页启用角色。</div>;
  }

  const selectedNode = definition.nodes.find(node => node.id === selectedNodeId) ?? null;

  return (
    <div className="pipeline-canvas-layout">
      <div className="pipeline-toolbar">
        {NODE_PALETTE.map(item => (
          <button
            key={item.type}
            className="pipeline-palette-btn"
            onClick={() => addNode(item.type, item.label)}
          >
            + {item.label}
          </button>
        ))}
        <span className="pipeline-toolbar-hint">编辑模式下拖出连线；选中后按 Delete 删除</span>
        <span className="pipeline-toolbar-spacer" />
        {pipeline.generated && !dirty && <span className="pipeline-badge">自动生成</span>}
        {dirty && <span className="pipeline-badge dirty">未保存</span>}
        <button className="pipeline-save-btn" disabled={!dirty || saving} onClick={save}>
          {saving ? '保存中…' : '保存并热加载'}
        </button>
        {dirty && (
          <button className="pipeline-discard-btn" onClick={discard}>
            放弃
          </button>
        )}
      </div>
      {saveError && <div className="pipeline-error">保存失败：{saveError}</div>}
      <div className="pipeline-main">
        <PipelineGraph
          definition={definition}
          runs={runs ?? []}
          onSelectNode={handleSelectNode}
          onMoveAllNodes={handleMoveAllNodes}
          onAddEdge={handleAddEdge}
          onDeleteNodes={handleDeleteNodes}
          onDeleteEdges={handleDeleteEdges}
        />
        {selectedNode && (
          <NodeInspector
            node={selectedNode}
            definition={definition}
            project={project}
            generated={pipeline?.generated ?? false}
            onChange={updated => {
              mutate(def => updateNodeInDefinition(def, updated));
            }}
            onConfigSaved={refresh}
          />
        )}
      </div>
    </div>
  );
}

/** 节点检查器：trigger 编辑调度；reviewer/maintainer 嵌入角色配置；其余展示只读信息 */
function NodeInspector({
  node,
  definition,
  project,
  generated,
  onChange,
  onConfigSaved,
}: {
  node: PipelineNodeDto;
  definition: PipelineDefinitionDto;
  project: Project | null;
  /** 正本是否仍是自动生成件（画布保存后转人类正本） */
  generated: boolean;
  onChange: (node: PipelineNodeDto) => void;
  /** 角色配置保存后刷新管线（生成件可能已被重建） */
  onConfigSaved: () => void;
}) {
  const roleType = node.type.startsWith('role.') ? node.type.slice(5) : null;
  const upstreamTrigger =
    roleType != null
      ? definition.nodes.find(
          candidate =>
            candidate.type === 'trigger.cron' &&
            definition.edges.some(
              edge => edge.from.node === candidate.id && edge.to.node === node.id
            )
        )
      : undefined;

  return (
    <aside className="pipeline-inspector">
      <h3>{node.label ?? node.id}</h3>
      <div className="pipeline-inspector-field">
        <label>节点 ID</label>
        <code>{node.id}</code>
      </div>
      <div className="pipeline-inspector-field">
        <label>类型</label>
        <code>{node.type}</code>
      </div>
      <div className="pipeline-inspector-field">
        <label>显示名</label>
        <input
          value={node.label ?? ''}
          placeholder={node.id}
          onChange={event => onChange({ ...node, label: event.target.value || undefined })}
        />
      </div>
      {node.type === 'trigger.cron' && (
        <div className="pipeline-inspector-field">
          <label>cron 调度表达式</label>
          <input
            value={String(node.params.schedule ?? '')}
            placeholder="*/10 * * * *"
            onChange={event =>
              onChange({ ...node, params: { ...node.params, schedule: event.target.value } })
            }
          />
        </div>
      )}
      {roleType === 'reviewer' || roleType === 'maintainer' ? (
        <div className="pipeline-inspector-role">
          {upstreamTrigger && (
            <div className="pipeline-inspector-field">
              <label>调度（上游触发器）</label>
              <code>{String(upstreamTrigger.params.schedule ?? '')}</code>
              {!generated && (
                <span className="pipeline-inspector-hint">
                  正本已由画布接管：调度以上方触发器节点为准，下方角色配置中的调度设置不再生效。
                </span>
              )}
            </div>
          )}
          {project && (
            <RoleProjectConfig role={roleType} project={project} onSaved={onConfigSaved} />
          )}
        </div>
      ) : null}
      {roleType === 'archiver' && (
        <p className="pipeline-inspector-hint">Archiver 的详细配置请在 Archiver 页维护。</p>
      )}
    </aside>
  );
}
