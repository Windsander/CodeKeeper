import { useIpc } from './useIpc';

export interface ModelLogsResult {
  embedding: string[];
  rerank: string[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useModelLogs(lines?: number): ModelLogsResult {
  const {
    data: embeddingData,
    loading: embeddingLoading,
    error: embeddingError,
    refresh: refreshEmbedding,
  } = useIpc<{ lines: string[] }>('localModel.logs', { capability: 'embedding', lines }, { pollInterval: 3000 });

  const {
    data: rerankData,
    loading: rerankLoading,
    error: rerankError,
    refresh: refreshRerank,
  } = useIpc<{ lines: string[] }>('localModel.logs', { capability: 'rerank', lines }, { pollInterval: 3000 });

  return {
    embedding: embeddingData?.lines ?? [],
    rerank: rerankData?.lines ?? [],
    loading: embeddingLoading || rerankLoading,
    error: embeddingError || rerankError,
    refresh: () => {
      refreshEmbedding();
      refreshRerank();
    },
  };
}
