import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { z } from 'zod';
import { logger } from './core/logger.js';
import { getConfigDir } from './core/platform.js';
import type { ProjectConfig } from './types.js';

const ReviewFilterSchema = z.object({
  excludeAuthors: z.array(z.string()).default([]),
  excludeDrafts: z.boolean().default(true),
  minChanges: z.number().int().min(0).default(1),
  maxChanges: z.number().int().min(1).default(300),
  excludePaths: z.array(z.string()).default(['**/*.md', 'docs/**']),
});

const ProjectSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  localPath: z.string(),
  git: z.object({
    remote: z.string(),
    defaultBranch: z.string().default('main'),
  }),
  gitlab: z.object({
    baseUrl: z.string().url(),
    projectPath: z.string(),
    token: z.string(),
  }),
  review: z.object({
    enabled: z.boolean().default(true),
    schedule: z.string().default('*/30 * * * *'),
    timezone: z.string().default('Asia/Shanghai'),
    tokenBudget: z.number().int().min(1000).default(200000),
    autoFix: z.boolean().default(false),
    autoFixBranchPrefix: z.string().default('codekeeper/fix-'),
    rulesFile: z.string().default('CLAUDE.md'),
    astGrepConfig: z.string().default('.claude/rules/sgconfig.yml'),
    filter: ReviewFilterSchema.default({}),
  }),
  learning: z.object({
    enabled: z.boolean().default(true),
    schedule: z.string().default('0 2 * * *'),
    patternThreshold: z.number().int().min(1).default(3),
    updateClaudeMd: z.boolean().default(true),
    createAstGrepRules: z.boolean().default(true),
    lookbackDays: z.number().int().min(1).default(7),
  }),
});

const ConfigSchema = z.object({
  projects: z.array(ProjectSchema).min(1),
});

/**
 * Load configuration from environment variables (.env driven)
 * Falls back to projects.yaml if no env-based projects found
 */
export function loadConfig(configPath?: string): { projects: ProjectConfig[] } {
  // Try env-based config first
  const envProjects = parseEnvProjects();
  if (envProjects.length > 0) {
    logger.info(`Loaded ${envProjects.length} project(s) from environment variables`);
    return { projects: envProjects };
  }

  // Fallback to YAML config file
  const fileConfig = loadFileConfig(configPath);
  if (fileConfig) {
    logger.info(`Loaded ${fileConfig.projects.length} project(s) from config file`);
    return fileConfig;
  }

  throw new Error(
    'No projects configured.\n\n' +
      'Option 1: Set environment variables in .env:\n' +
      '  CODEKEEPER_PROJECT_{ID}_PATH=/path/to/project\n' +
      '  CODEKEEPER_PROJECT_{ID}_GITLAB_URL=https://git.example.com\n' +
      '  CODEKEEPER_PROJECT_{ID}_GITLAB_PROJECT=group/project\n' +
      '  CODEKEEPER_PROJECT_{ID}_TOKEN=glpat-xxxxx\n\n' +
      'Option 2: Create config/projects.yaml (see config/projects.example.yaml)'
  );
}

/**
 * Parse project configurations from CODEKEEPER_PROJECT_* environment variables
 *
 * Expected format:
 * CODEKEEPER_PROJECT_MYPROJECT_PATH=/path/to/project
 * CODEKEEPER_PROJECT_MYPROJECT_GITLAB_URL=https://git.example.com
 * CODEKEEPER_PROJECT_MYPROJECT_GITLAB_PROJECT=group/project
 * CODEKEEPER_PROJECT_MYPROJECT_TOKEN=glpat-xxxxx
 * CODEKEEPER_PROJECT_MYPROJECT_SCHEDULE=\*\/30 * * * * (optional)
 * CODEKEEPER_PROJECT_MYPROJECT_AUTO_FIX=false (optional)
 */
function parseEnvProjects(): ProjectConfig[] {
  const prefix = 'CODEKEEPER_PROJECT_';
  const projectKeys = new Map<string, Record<string, string>>();

  // Group env vars by project ID
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(prefix) || !value) continue;

    // Extract project ID and field name
    // e.g. CODEKEEPER_PROJECT_MYPROJECT_PATH -> id=MYPROJECT, field=PATH
    const rest = key.slice(prefix.length); // e.g. "MYPROJECT_PATH"
    const firstUnderscore = rest.indexOf('_');
    if (firstUnderscore === -1) continue;

    const id = rest.slice(0, firstUnderscore).toLowerCase();
    const field = rest.slice(firstUnderscore + 1);

    if (!projectKeys.has(id)) {
      projectKeys.set(id, {});
    }
    projectKeys.get(id)![field] = value;
  }

  const projects: ProjectConfig[] = [];

  for (const [id, fields] of projectKeys) {
    // Skip projects without required fields
    if (!fields.PATH) {
      logger.warn(`Project "${id}" missing PATH, skipping`);
      continue;
    }

    const project = buildProjectConfig(id, fields);
    projects.push(project);
  }

  return projects;
}

function buildProjectConfig(id: string, fields: Record<string, string>): ProjectConfig {
  const name = id.split('-').map(capitalize).join(' ');

  return {
    id,
    name,
    localPath: path.resolve(resolveEnvValue(fields.PATH)),
    git: {
      remote: fields.GIT_REMOTE || `git@${extractHost(fields.GITLAB_URL || '')}:${fields.GITLAB_PROJECT || ''}.git`,
      defaultBranch: fields.GIT_BRANCH || 'main',
    },
    gitlab: {
      baseUrl: fields.GITLAB_URL || 'https://gitlab.com',
      projectPath: fields.GITLAB_PROJECT || '',
      token: resolveEnvValue(fields.TOKEN || ''),
    },
    review: {
      enabled: parseBool(fields.ENABLED, true),
      schedule: fields.SCHEDULE || process.env.CODEKEEPER_SCHEDULE || '*/30 * * * *',
      timezone: process.env.CODEKEEPER_TIMEZONE || 'Asia/Shanghai',
      tokenBudget: parseInt(process.env.CODEKEEPER_TOKEN_BUDGET || '200000', 10),
      autoFix: parseBool(fields.AUTO_FIX, false),
      autoFixBranchPrefix: 'codekeeper/fix-',
      rulesFile: 'CLAUDE.md',
      astGrepConfig: '.claude/rules/sgconfig.yml',
      filter: {
        excludeAuthors: ['bot', 'ci'],
        excludeDrafts: true,
        minChanges: 1,
        maxChanges: 300,
        excludePaths: ['**/*.md', 'docs/**'],
      },
    },
    learning: {
      enabled: parseBool(fields.LEARN_ENABLED, true),
      schedule: '0 2 * * *',
      patternThreshold: 3,
      updateClaudeMd: true,
      createAstGrepRules: true,
      lookbackDays: 7,
    },
  };
}

function extractHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'gitlab.com';
  }
}

function resolveEnvValue(value: string): string {
  if (!value) return '';
  if (value.startsWith('env:')) {
    const varName = value.slice(4);
    const envValue = process.env[varName];
    if (!envValue) {
      logger.warn(`Environment variable ${varName} not found`);
      return '';
    }
    return envValue;
  }
  return value;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true';
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Load from YAML config file (legacy support)
 */
function loadFileConfig(configPath?: string): { projects: ProjectConfig[] } | null {
  const paths = [
    configPath,
    process.env.CODEKEEPER_CONFIG,
    path.join(process.cwd(), 'config', 'projects.yaml'),
    path.join(process.cwd(), 'projects.yaml'),
    path.join(getConfigDir(), 'projects.yaml'),
  ].filter(Boolean) as string[];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      const parsed = YAML.parse(content);
      const validated = ConfigSchema.parse(parsed);
      return {
        projects: validated.projects.map((p: ProjectConfig) => ({
          ...p,
          localPath: path.resolve(p.localPath),
          gitlab: {
            ...p.gitlab,
            token: resolveEnvValue(p.gitlab.token),
          },
        })),
      };
    }
  }

  return null;
}

export function validateProject(project: ProjectConfig): string[] {
  const errors: string[] = [];

  if (!fs.existsSync(project.localPath)) {
    errors.push(`localPath does not exist: ${project.localPath}`);
  } else {
    const gitDir = path.join(project.localPath, '.git');
    if (!fs.existsSync(gitDir)) {
      errors.push(`Not a git repository: ${project.localPath}`);
    }
  }

  if (!project.gitlab.token) {
    errors.push('GitLab token is empty (check env var resolution)');
  }

  if (project.review.tokenBudget < 10000) {
    errors.push(`tokenBudget too low: ${project.review.tokenBudget}`);
  }

  return errors;
}
