import { useCallback } from 'react';
import { useIpc } from './useIpc';
import type { MemorySearchParams, MemorySearchResult } from '../../shared/types.js';

/**
 * 记忆浏览器查询 Hook
 * 基于 useIpc 封装 memory.search，提供刷新能力。
 */
export function useMemoryQuery(params: MemorySearchParams) {
  const { data, loading, error, refresh } = useIpc<MemorySearchResult>('memory.search', params, {
    pollInterval: 0,
  });

  const refetch = useCallback(() => {
    void refresh();
  }, [refresh]);

  return {
    entries: data?.entries ?? [],
    loading,
    error,
    refetch,
  };
}
