import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../api/electron-api.js';

type Role = 'reviewer' | 'maintainer' | 'archiver';

interface RoleServiceStatus {
  running: boolean;
  enabledProjects: number;
  runningProjects: string[];
}

interface RoleServiceViewState {
  status?: RoleServiceStatus;
  error?: string;
}

const ROLES: Array<{ role: Role; label: string }> = [
  { role: 'reviewer', label: 'Reviewer' },
  { role: 'maintainer', label: 'Maintainer' },
  { role: 'archiver', label: 'Archiver' },
];

/** Dashboard 全局角色服务控制区。角色是跨项目运行时，项目配置仍留在管线节点检查器。 */
export function GlobalRoleServices() {
  const [statuses, setStatuses] = useState<Partial<Record<Role, RoleServiceViewState>>>({});
  const [busyRoles, setBusyRoles] = useState<Set<Role>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const requestId = useRef(0);
  const mounted = useRef(true);
  const busyRolesRef = useRef<Set<Role>>(new Set());

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    const entries = await Promise.all(
      ROLES.map(async ({ role }) => {
        try {
          const status = await invoke<RoleServiceStatus>('role.service.status', { role });
          return [role, { status }] as const;
        } catch (error) {
          return [role, { error: error instanceof Error ? error.message : String(error) }] as const;
        }
      })
    );
    if (currentRequest !== requestId.current) return;
    setStatuses(previous => {
      const next = { ...previous };
      for (const [role, state] of entries) next[role] = state;
      return next;
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (!mounted.current || document.visibilityState === 'hidden') return;
      timer = setTimeout(async () => {
        await refresh();
        scheduleRefresh();
      }, 3000);
    };
    void refresh();
    scheduleRefresh();
    const handleVisibility = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (document.visibilityState === 'visible') void refresh();
      scheduleRefresh();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      mounted.current = false;
      requestId.current += 1;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refresh]);

  const changeService = async (role: Role, action: 'start' | 'stop' | 'restart') => {
    if (busyRolesRef.current.has(role)) return;
    busyRolesRef.current.add(role);
    setBusyRoles(previous => new Set(previous).add(role));
    setActionError(null);
    try {
      await invoke(`role.service.${action}`, { role });
      await refresh();
    } catch (error) {
      if (mounted.current) {
        setActionError(
          `${labelForRole(role)}${actionLabel(action)}失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    } finally {
      busyRolesRef.current.delete(role);
      if (mounted.current) {
        setBusyRoles(previous => {
          const next = new Set(previous);
          next.delete(role);
          return next;
        });
      }
    }
  };

  return (
    <section className="dashboard-services" aria-label="全局角色服务">
      <div className="dashboard-services-heading">
        <div>
          <h2>全局角色服务</h2>
          <p>控制跨项目运行的 Role 节点。项目级启用状态在各项目管线中管理。</p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()}>
          刷新
        </button>
      </div>
      <div className="dashboard-service-grid">
        {ROLES.map(({ role, label }) => {
          const status = statuses[role];
          const unavailable = Boolean(status?.error);
          const busy = busyRoles.has(role);
          return (
            <div key={role} className="dashboard-service-item">
              <div className="dashboard-service-title">
                <strong>{label}</strong>
                <span className={`service-dot ${status?.status?.running ? 'running' : 'idle'}`} />
                <span>
                  {unavailable ? '状态不可用' : status?.status?.running ? '运行中' : '已停止'}
                </span>
              </div>
              <div className="dashboard-service-meta">
                {unavailable
                  ? (status?.error ?? '状态查询失败')
                  : `${status?.status?.enabledProjects ?? 0} 个项目可运行`}
              </div>
              <div className="dashboard-service-actions">
                {status?.status?.running ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busy || unavailable}
                      onClick={() => void changeService(role, 'restart')}
                    >
                      重启
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busy || unavailable}
                      onClick={() => void changeService(role, 'stop')}
                    >
                      停止
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy || unavailable}
                    onClick={() => void changeService(role, 'start')}
                  >
                    启动
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {actionError && <div className="error-message dashboard-service-error">{actionError}</div>}
    </section>
  );
}

function labelForRole(role: Role): string {
  return ROLES.find(item => item.role === role)?.label ?? role;
}

function actionLabel(action: 'start' | 'stop' | 'restart'): string {
  return action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启';
}
