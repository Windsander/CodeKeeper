import { useEffect, useState, useCallback, useRef } from 'react';
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

export function useIpc<T>(method: string, params?: unknown, options?: { pollInterval?: number }) {
  const paramsKey = JSON.stringify(params);
  const cacheKey = `${method}:${paramsKey}`;
  const cached = cache.get(cacheKey) as T | undefined;
  const pollInterval = options?.pollInterval;

  const [data, setData] = useState<T | null>(cached ?? null);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const initializedRef = useRef(false);

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
    if (initializedRef.current) return;
    initializedRef.current = true;
    // 有缓存时直接展示旧数据并后台静默刷新，避免页面切换出现 loading
    if (cached) {
      refresh(true);
    } else {
      refresh();
    }
  }, [refresh, cached]);

  useEffect(() => {
    if (!pollInterval || pollInterval <= 0) return;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const scheduleNext = () => {
      if (disposed) return;
      timeoutId = setTimeout(() => {
        refresh(true).finally(() => {
          // 上一次请求完成后再排下一次，避免 IPC 请求堆积
          scheduleNext();
        });
      }, pollInterval);
    };

    // 页面可见时才轮询；切回前台时立即刷新一次，避免后台节流导致状态 stale
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      } else {
        refresh(true);
        scheduleNext();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    handleVisibilityChange();

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [refresh, pollInterval]);

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
