import { registerRoleUI } from './role-registry.js';
import { ReviewerIcon } from '../components/icons.js';

const DEFAULT_REVIEWER_SOUL = `## MR Reviewer Soul

你是一名严谨的代码评审员...
`;

registerRoleUI<'reviewer'>({
  role: 'reviewer',
  displayName: '自动评审',
  navLabel: '自动评审',
  routePath: '/reviewer',
  icon: ReviewerIcon,
  soulFileName: 'MR-REVIEWER-SOUL.md',
  defaultSoulTemplate: DEFAULT_REVIEWER_SOUL,
  projectConfigFields: [],
  defaultConfig: {
    role: 'reviewer',
    enabled: false,
    reviewSchedule: '*/10 * * * *',
    learningEnabled: true,
  },
});
