import { useEffect, useState, useCallback } from 'react';
import { invoke } from '../api/electron-api';

const cache = new Map<string, unknown>();

export function clearIpcCache(method?: string): void {
  if (!method) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${method}:`)) {
      cache.delete(key);
    }
  }
}

export function mutateIpcCache<T>(method: string, params: unknown, data: T): void {
  const cacheKey = `${method}:${JSON.stringify(params)}`;
  cache.set(cacheKey, data);
}

export function useIpc<T>(method: string, params?: unknown) {
  const paramsKey = JSON.stringify(params);
  const cacheKey = `${method}:${paramsKey}`;
  const cached = cache.get(cacheKey) as T | undefined;

  const [data, setData] = useState<T | null>(cached ?? null);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    (silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      invoke<T>(method, params)
        .then((result) => {
          cache.set(cacheKey, result);
          setData(result);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => {
          if (!silent) setLoading(false);
        });
    },
    [method, paramsKey, cacheKey]
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  const mutate = useCallback(
    (value: T | ((prev: T | null) => T | null)) => {
      setData((prev) => {
        const next =
          typeof value === 'function'
            ? (value as (prev: T | null) => T | null)(prev)
            : value;
        if (next !== null) {
          cache.set(cacheKey, next);
        }
        return next;
      });
    },
    [cacheKey]
  );

  return { data, loading, error, refresh, mutate };
}
