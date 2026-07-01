import { registerRoleUI } from './role-registry.js';
import { MaintainerIcon } from '../components/icons.js';

const DEFAULT_MAINTAINER_SOUL = `## Maintainer Soul

你是一名细心的代码维护者...
`;

registerRoleUI<'maintainer'>({
  role: 'maintainer',
  displayName: '自动维护',
  navLabel: '自动维护',
  routePath: '/maintainer',
  icon: MaintainerIcon,
  soulFileName: 'MAINTAINER-SOUL.md',
  defaultSoulTemplate: DEFAULT_MAINTAINER_SOUL,
  projectConfigFields: [
    { key: 'maintainerName', label: '维护者名称', type: 'text', defaultValue: 'CodeKeeper Maintainer' },
    { key: 'autoFixRiskLevels', label: '自动处理风险等级', type: 'risk-levels', defaultValue: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
    { key: 'resolveOthersDiscussions', label: '自动 resolve 他人 discussion', type: 'toggle', defaultValue: true },
  ],
  defaultConfig: {
    role: 'maintainer',
    enabled: false,
    reviewSchedule: '*/10 * * * *',
    learningEnabled: true,
    maintainerName: 'CodeKeeper Maintainer',
    autoFixEnabled: true,
    autoFixRiskLevels: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
    resolveOthersDiscussions: true,
  },
});
