import { PageHeader } from '../components/PageHeader.js';
import { ServiceStatusPanel } from '../components/ServiceStatusPanel.js';
import { useServiceStatus } from '../hooks/useServiceStatus.js';
import { MemoryStatsIcon } from '../components/icons.js';

/** 全局服务状态入口，与设置页配置职责分离。 */
export function SystemStatusPage() {
  const { daemon, localModel, remoteModel, loading } = useServiceStatus();

  return (
    <div className="system-status-page">
      <PageHeader icon={<MemoryStatsIcon />} title="系统状态" />
      {loading ? (
        <div className="loading">加载服务状态...</div>
      ) : (
        <ServiceStatusPanel daemon={daemon} localModel={localModel} remoteModel={remoteModel} />
      )}
    </div>
  );
}
