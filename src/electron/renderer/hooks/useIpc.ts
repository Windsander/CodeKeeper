import { useEffect, useState, useCallback } from 'react';
import { invoke } from '../api/electron-api';

export function useIpc<T>(method: string, params?: unknown) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 用 JSON 序列化稳定 params 引用，避免对象字面量导致无限重试
  const paramsKey = JSON.stringify(params);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    invoke<T>(method, params)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [method, paramsKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}
