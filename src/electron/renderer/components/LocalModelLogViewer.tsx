import { useEffect, useRef } from 'react';
import { useModelLogs } from '../hooks/useModelLogs';

/**
 * 本地模型（Embedding / Rerank）日志查看器。
 * 从 IPC 轮询模型进程日志，并自动滚动到底部。
 */
export function LocalModelLogViewer() {
  const { embedding, rerank, loading, error } = useModelLogs();
  const embeddingRef = useRef<HTMLPreElement>(null);
  const rerankRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (embeddingRef.current) {
      embeddingRef.current.scrollTop = embeddingRef.current.scrollHeight;
    }
  }, [embedding]);

  useEffect(() => {
    if (rerankRef.current) {
      rerankRef.current.scrollTop = rerankRef.current.scrollHeight;
    }
  }, [rerank]);

  if (loading && embedding.length === 0 && rerank.length === 0) {
    return <div className="model-log-empty">加载日志中...</div>;
  }
  if (error) {
    return <div className="model-log-error">读取日志失败: {error}</div>;
  }

  return (
    <div className="model-log-viewer">
      <div className="model-log-section">
        <h4 className="model-log-title">Embedding</h4>
        <pre ref={embeddingRef} className="model-log-pre">
          {embedding.join('\n') || '暂无日志'}
        </pre>
      </div>
      <div className="model-log-section">
        <h4 className="model-log-title">Rerank</h4>
        <pre ref={rerankRef} className="model-log-pre">
          {rerank.join('\n') || '暂无日志'}
        </pre>
      </div>
    </div>
  );
}
