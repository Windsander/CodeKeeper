import { useState, useCallback } from 'react';
import { useMemoryQuery } from '../hooks/useMemoryQuery';
import { useIpc } from '../hooks/useIpc';
import { invoke } from '../api/electron-api';
import type { MemoryEntry, Project } from '../../shared/types.js';

const TYPE_LABELS: Record<MemoryEntry['type'], string> = {
  agent_case: 'Agent Case',
  episode: '用户 Episode',
  agent_skill: 'Agent Skill',
  profile: '用户 Profile',
};

const TYPE_BADGES: Record<MemoryEntry['type'], string> = {
  agent_case: 'badge-info',
  episode: 'badge-secondary',
  agent_skill: 'badge-success',
  profile: 'badge-warning',
};

function truncate(text: string, max = 200): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

export function MemoryBrowser() {
  const { data: projects } = useIpc<Project[]>('project.list');
  const [projectId, setProjectId] = useState('');
  const [owner, setOwner] = useState<'agent' | 'user' | ''>('');
  const [agentId, setAgentId] = useState('');
  const [userId, setUserId] = useState('');
  const [query, setQuery] = useState('');

  const searchParams = buildSearchParams(projectId, owner, agentId, userId, query);
  const { entries, loading, error, refetch } = useMemoryQuery(searchParams);

  const handleDelete = useCallback(
    async (entry: MemoryEntry) => {
      if (!projectId) return;
      if (!confirm('确定要删除这条记忆吗？')) return;
      await invoke('memory.delete', { projectId, sessionId: entry.sessionId });
      void refetch();
    },
    [projectId, refetch]
  );

  return (
    <div className="memory-browser">
      <div className="page-header">
        <h2 className="page-title">记忆浏览器</h2>
      </div>

      <div className="card memory-search-form">
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="memory-project">项目</label>
            <select
              id="memory-project"
              className="input"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">请选择项目</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="memory-owner">归属</label>
            <select
              id="memory-owner"
              className="input"
              value={owner}
              onChange={(e) => {
                setOwner(e.target.value as 'agent' | 'user' | '');
                setAgentId('');
                setUserId('');
              }}
            >
              <option value="">全部</option>
              <option value="agent">Agent</option>
              <option value="user">用户</option>
            </select>
          </div>

          {owner === 'agent' && (
            <div className="form-group">
              <label htmlFor="memory-agent">Agent ID</label>
              <select
                id="memory-agent"
                className="input"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              >
                <option value="">请选择</option>
                <option value="reviewer">reviewer</option>
                <option value="maintainer">maintainer</option>
                <option value="archiver">archiver</option>
              </select>
            </div>
          )}

          {owner === 'user' && (
            <div className="form-group">
              <label htmlFor="memory-user">用户 ID</label>
              <input
                id="memory-user"
                className="input"
                type="text"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="例如 alice"
              />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="memory-query">关键词</label>
            <input
              id="memory-query"
              className="input"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索记忆内容"
            />
          </div>
        </div>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      <div className="card">
        {loading && entries.length === 0 ? (
          <div className="empty-state">加载中…</div>
        ) : entries.length === 0 ? (
          <div className="empty-state">暂无匹配记忆</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>类型</th>
                <th>内容</th>
                <th>来源</th>
                <th>时间</th>
                <th>Score</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <span className={`badge ${TYPE_BADGES[entry.type]}`}>
                      {TYPE_LABELS[entry.type]}
                    </span>
                  </td>
                  <td className="memory-entry-content">{truncate(entry.content)}</td>
                  <td>{entry.source}</td>
                  <td>{entry.timestamp}</td>
                  <td>{entry.score?.toFixed(3) ?? '-'}</td>
                  <td>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => handleDelete(entry)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function buildSearchParams(
  projectId: string,
  owner: 'agent' | 'user' | '',
  agentId: string,
  userId: string,
  query: string
): { projectId: string; agentId?: string; userId?: string; query?: string; limit?: number } {
  const params: { projectId: string; agentId?: string; userId?: string; query?: string; limit?: number } = {
    projectId,
    query: query || undefined,
    limit: 50,
  };
  if (owner === 'agent' && agentId) {
    params.agentId = agentId;
  } else if (owner === 'user' && userId) {
    params.userId = userId;
  }
  return params;
}
