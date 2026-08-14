import { ArchiverProviderConfig } from '../components/ArchiverProviderConfig.js';
import { ArchiverIcon } from '../components/icons.js';
import { createDefaultArchiverConfig } from './archiver-defaults.js';
import { registerRoleUI } from './role-registry.js';

const DEFAULT_ARCHIVER_SOUL = `## Archiver Soul

你负责持续维护项目的代码结构、文档知识和长期维护上下文。
`;

registerRoleUI<'archiver'>({
  role: 'archiver',
  displayName: '项目知识',
  navLabel: '项目知识',
  routePath: '/archiver',
  icon: ArchiverIcon,
  soulFileName: 'ARCHIVER-SOUL.md',
  defaultSoulTemplate: DEFAULT_ARCHIVER_SOUL,
  projectConfigFields: [],
  defaultConfig: createDefaultArchiverConfig(),
  requiresGitlab: false,
  projectDescription:
    'Provider 由系统自动遴选、启动和回退，用户无需配置 Provider；按需设置 Archiver 身份和自动运行频率即可。Archiver 只依赖本地项目目录，不要求 GitLab。',
  serviceDescription:
    '项目知识服务自动编排代码结构 Provider，并由内置阶段持续提炼文档、约定、领域知识和维护风险。外部 Provider 不可用时会自动回退，不会阻断其他项目。',
  projectConfigComponent: ArchiverProviderConfig,
});
