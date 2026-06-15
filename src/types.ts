/**
 * CodeKeeper 共享类型定义
 */

export interface ProjectConfig {
  id: string;
  name: string;
  localPath: string;
  git: {
    remote: string;
    defaultBranch: string;
  };
  gitlab: {
    baseUrl: string;
    projectPath: string;
    token: string;
  };
  review: {
    enabled: boolean;
    schedule: string;
    timezone: string;
    tokenBudget: number;
    autoFix: boolean;
    autoFixBranchPrefix: string;
    rulesFile: string;
    astGrepConfig: string;
    filter: ReviewFilter;
  };
  learning: {
    enabled: boolean;
    schedule: string;
    patternThreshold: number;
    updateClaudeMd: boolean;
    createAstGrepRules: boolean;
    lookbackDays: number;
  };
}

export interface ReviewFilter {
  excludeAuthors: string[];
  excludeDrafts: boolean;
  minChanges: number;
  maxChanges: number;
  excludePaths: string[];
}

export interface MergeRequest {
  iid: number;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  draft: boolean;
  changesCount: number;
  createdAt: string;
  updatedAt: string;
  webUrl: string;
}

export interface MrDiff {
  filePath: string;
  oldPath: string;
  newPath: string;
  newFile: boolean;
  deletedFile: boolean;
  diff: string;
  additions: number;
  deletions: number;
}

export interface ReviewFinding {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  file: string;
  line: number;
  ruleId?: string;
  message: string;
  suggestion: string;
}

export interface ReviewResult {
  findings: ReviewFinding[];
  summary: string;
  autoFixable: number[];
  rawResponse?: string;
}

export interface AstGrepFinding {
  file: string;
  line: number;
  column: number;
  ruleId: string;
  message: string;
  severity: string;
}

export interface TokenBudget {
  total: number;
  used: number;
  remaining: number;
}

export interface DiffChunk {
  files: MrDiff[];
  estimatedTokens: number;
  index: number;
  total: number;
}

export interface LearningPattern {
  category: string;
  count: number;
  examples: string[];
  lastSeen: string;
}

export interface ReviewComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
}
