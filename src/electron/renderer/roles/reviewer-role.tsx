import { registerRoleUI } from './role-registry.js';
import type { ReviewerConfig } from '../../../advance/types.js';

/**
 * Reviewer 角色图标（占位）
 */
function ReviewerIcon() {
  return <span>R</span>;
}

const DEFAULT_REVIEWER_SOUL = `## MR Reviewer Soul

你是一名严谨的代码评审员...
`;

registerRoleUI<ReviewerConfig>({
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
