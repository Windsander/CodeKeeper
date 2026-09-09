import { useIpc } from '../hooks/useIpc.js';
import { invoke } from '../api/electron-api.js';
import { useState } from 'react';
import type { ArchiveAction, PipelineRunDto, ProjectStatus } from '../../shared/types.js';

interface RunCenterProps {
  projectId: string;
}

interface RunAction extends ArchiveAction {
  status: 'applied' | 'undone';
}

/** 项目运行中心：统一展示管线运行、归档动作和扫描健康度。 */
export function RunCenter({ projectId }: RunCenterProps) {
  const [undoing, setUndoing] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const { data: runs, error: runsError } = useIpc<PipelineRunDto[]>(
    'pipeline.runs',
    { projectId, limit: 20 },
    { pollInterval: 5000 }
  );
  const {
    data: actions,
    error: actionsError,
    refresh: refreshActions,
  } = useIpc<RunAction[]>('action.history', { projectId, limit: 20 }, { pollInterval: 5000 });
  const { data: status, error: statusError } = useIpc<ProjectStatus>(
    'project.status',
    { projectId },
    { pollInterval: 5000 }
  );

  const undo = async (actionId: string) => {
    setUndoing(actionId);
    setUndoError(null);
    try {
      const result = await invoke<{ success: boolean; message?: string }>('action.undo', {
        projectId,
        actionId,
      });
      if (!result.success) {
        setUndoError(result.message ?? '撤销失败');
        return;
      }
      refreshActions(true);
    } catch (error) {
      setUndoError(error instanceof Error ? error.message : String(error));
    } finally {
      setUndoing(null);
    }
  };

  return (
    <div className="run-center">
      {(runsError || actionsError || statusError) && (
        <div className="error-message">
          运行数据加载失败：{runsError || actionsError || statusError}
        </div>
      )}
      {undoError && <div className="error-message">撤销失败：{undoError}</div>}
      <section className="run-summary-grid">
        <div className="run-summary-item">
          <span>最近管线运行</span>
          <strong>{runs?.length ?? 0}</strong>
        </div>
        <div className="run-summary-item">
          <span>归档动作</span>
          <strong>{actions?.length ?? 0}</strong>
        </div>
        <div className="run-summary-item">
          <span>扫描状态</span>
          <strong>
            {status?.scanStatus === 'success' ? '正常' : (status?.scanStatus ?? '暂无')}
          </strong>
        </div>
        <div className="run-summary-item">
          <span>待处理</span>
          <strong>{status?.pendingCount ?? 0}</strong>
        </div>
      </section>

      <section className="run-section">
        <div className="run-section-heading">
          <h2>管线运行</h2>
          <span>按最近时间排序</span>
        </div>
        {!runs?.length && <div className="run-empty">暂无管线运行记录。</div>}
        {runs?.map(run => (
          <div key={run.id} className="run-row">
            <span className={`run-status run-status-${run.status}`}>{run.status}</span>
            <code>{run.id.slice(0, 8)}</code>
            <span>{run.stages.length} 个节点</span>
            <time>{new Date(run.createdAt).toLocaleString()}</time>
            {run.error && <span className="run-error">{run.error}</span>}
          </div>
        ))}
      </section>

      <section className="run-section">
        <div className="run-section-heading">
          <h2>归档动作</h2>
          <span>可在动作行执行撤销</span>
        </div>
        {!actions?.length && <div className="run-empty">暂无归档动作记录。</div>}
        {actions?.slice(0, 20).map(action => (
          <div key={action.id} className="run-row">
            <span className="run-action-type">{action.type}</span>
            <span className="run-path">{action.sourcePath}</span>
            <span>{action.risk}</span>
            <time>{new Date(action.createdAt).toLocaleString()}</time>
            {action.status === 'applied' && (
              <button
                className="action-undo-btn"
                disabled={undoing === action.id}
                aria-label="撤销"
                onClick={() => void undo(action.id)}
              >
                撤销
              </button>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
