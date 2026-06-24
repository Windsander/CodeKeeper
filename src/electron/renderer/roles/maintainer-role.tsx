import { registerRoleUI } from './role-registry.js';
import type { MaintainerConfig } from '../../../advance/types.js';

/**
 * Maintainer 角色图标（占位）
 */
function MaintainerIcon() {
  return <span>M</span>;
}

const DEFAULT_MAINTAINER_SOUL = `## Maintainer Soul

你是一名细心的代码维护者...
`;

registerRoleUI<MaintainerConfig>({
  role: 'maintainer',
  displayName: '自动维护',
  navLabel: '自动维护',
  routePath: '/maintainer',
  icon: MaintainerIcon,
  soulFileName: 'MAINTAINER-SOUL.md',
  defaultSoulTemplate: DEFAULT_MAINTAINER_SOUL,
  projectConfigFields: [
    { key: 'maintainerName', label: '维护者名称', type: 'text', defaultValue: 'CodeKeeper Maintainer' },
    { key: 'autoFixEnabled', label: '启用自动修复', type: 'toggle', defaultValue: true },
    { key: 'resolveOthersDiscussions', label: '自动 resolve 他人 discussion', type: 'toggle', defaultValue: true },
  ],
  defaultConfig: {
    role: 'maintainer',
    enabled: false,
    reviewSchedule: '*/10 * * * *',
    learningEnabled: true,
    maintainerName: 'CodeKeeper Maintainer',
    autoFixEnabled: true,
    resolveOthersDiscussions: true,
  },
});
