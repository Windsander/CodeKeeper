import { useEffect, useState } from 'react';
import { invoke, showOpenDialog } from '../api/electron-api.js';
import { useIpc } from '../hooks/useIpc.js';
import type { Project } from '../../shared/types.js';

export function ProjectSettingsPanel({ projectId }: { projectId: string }) {
  const { data: project, refresh } = useIpc<Project>('project.get', { projectId });
  const { data: projectConfig, refresh: refreshConfig } = useIpc<{ content: string }>(
    'project.config',
    { projectId }
  );
  const [gitlab, setGitlab] = useState({
    baseUrl: '',
    projectPath: '',
    token: '',
    defaultBranch: 'main',
  });
  const [archiveRoot, setArchiveRoot] = useState('');
  const [configContent, setConfigContent] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (project) {
      setArchiveRoot(project.archiveRoot ?? '');
      setGitlab({
        baseUrl: project.gitlab?.baseUrl ?? '',
        projectPath: project.gitlab?.projectPath ?? '',
        token: project.gitlab?.token ?? '',
        defaultBranch: project.gitlab?.defaultBranch ?? 'main',
      });
    }
  }, [project]);
  useEffect(() => setConfigContent(projectConfig?.content ?? ''), [projectConfig]);

  const saveGitlab = async () => {
    try {
      setError(null);
      await invoke('project.gitlab.config.update', { projectId, gitlab });
      setMessage('GitLab 配置已保存');
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const saveArchiveRoot = async () => {
    try {
      setError(null);
      await invoke('project.archive-root.update', { projectId, archiveRoot });
      setMessage('归档位置已保存');
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const saveConfig = async () => {
    try {
      setError(null);
      await invoke('project.config.update', { projectId, content: configContent });
      setMessage('扫描规则已保存');
      refreshConfig();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const pickArchiveRoot = async () => {
    const result = await showOpenDialog({
      title: '选择归档目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!result.canceled && result.filePaths[0]) setArchiveRoot(result.filePaths[0]);
  };

  if (!project) return <div className="loading">加载项目设置...</div>;
  return (
    <div className="project-settings-panel">
      {message && <div className="success-message">{message}</div>}
      {error && <div className="error-message">保存失败：{error}</div>}
      <section className="project-settings-section">
        <div className="project-settings-heading">
          <h2>GitLab 项目</h2>
          <span>项目级连接配置</span>
        </div>
        <label>
          服务地址
          <input
            value={gitlab.baseUrl}
            onChange={e => setGitlab({ ...gitlab, baseUrl: e.target.value })}
          />
        </label>
        <label>
          项目路径
          <input
            value={gitlab.projectPath}
            onChange={e => setGitlab({ ...gitlab, projectPath: e.target.value })}
          />
        </label>
        <label>
          Access Token
          <input
            type="password"
            value={gitlab.token}
            onChange={e => setGitlab({ ...gitlab, token: e.target.value })}
          />
        </label>
        <label>
          默认分支
          <input
            value={gitlab.defaultBranch}
            onChange={e => setGitlab({ ...gitlab, defaultBranch: e.target.value })}
          />
        </label>
        <button className="btn btn-primary" onClick={() => void saveGitlab()}>
          保存 GitLab
        </button>
      </section>
      <section className="project-settings-section">
        <div className="project-settings-heading">
          <h2>归档位置</h2>
          <span>留空使用项目内 .codekeeper</span>
        </div>
        <div className="form-row">
          <input value={archiveRoot} onChange={e => setArchiveRoot(e.target.value)} />
          <button className="btn btn-secondary" onClick={() => void pickArchiveRoot()}>
            选择
          </button>
        </div>
        <button className="btn btn-primary" onClick={() => void saveArchiveRoot()}>
          保存归档位置
        </button>
      </section>
      <section className="project-settings-section">
        <div className="project-settings-heading">
          <h2>扫描规则</h2>
          <span>.codekeeper/config.yaml</span>
        </div>
        <textarea
          className="project-config-editor"
          value={configContent}
          onChange={e => setConfigContent(e.target.value)}
          spellCheck={false}
        />
        <button className="btn btn-primary" onClick={() => void saveConfig()}>
          保存扫描规则
        </button>
      </section>
    </div>
  );
}
