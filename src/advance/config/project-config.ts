import { readFileSync } from 'node:fs';
import { join, normalize, relative, resolve } from 'node:path';
import { minimatch } from 'minimatch';
import { z } from 'zod';
import YAML from 'yaml';

/** 无论项目配置如何都必须排除的依赖与版本控制目录。 */
export const SYSTEM_PROJECT_EXCLUDE_PATTERNS = ['**/node_modules/**', '**/.git/**'];

const DEFAULT_PROJECT_EXCLUDE_PATTERNS = [
  ...SYSTEM_PROJECT_EXCLUDE_PATTERNS,
  '**/dist/**',
  '**/release/*-unpacked/**',
  '**/.codekeeper/drafts/**',
  '**/*.tmp',
  '**/*.tmp.*',
  '**/*~',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/*.swp',
  '**/*.bak',
];

/**
 * 项目级 .codekeeper/config.yaml 的校验 schema
 */
export const projectConfigSchema = z.object({
  name: z.string().min(1).optional(),
  // 注意：name 未设置时由调用方（如 ProjectRegistry）回退到目录名
  include: z.array(z.string()).default([
    // 文档与配置文件：CodeKeeper 默认只归档这些非源代码文件
    '**/*.md',
    '**/*.mdx',
    '**/*.txt',
    '**/*.json',
    '**/*.yaml',
    '**/*.yml',
    '**/*.toml',
    '**/*.ini',
    '**/*.html',
    '**/*.htm',
    '**/*.xml',
    '**/*.svg',
  ]),
  exclude: z.array(z.string()).default(DEFAULT_PROJECT_EXCLUDE_PATTERNS),
  categories: z.array(z.string()).default([]),
  docTypes: z.array(z.string()).default([]),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

/**
 * 使用统一语义匹配项目相对路径。
 *
 * 同时尝试目录尾斜杠形式，确保 globstar 目录规则能在遍历进入目录前命中。
 */
export function matchesProjectPathPatterns(filePath: string, patterns: string[]): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalizedPath) return false;
  const directoryPath = `${normalizedPath}/`;
  return patterns.some(rawPattern => {
    const pattern = rawPattern.replace(/\\/g, '/');
    return (
      minimatch(normalizedPath, pattern, { dot: true }) ||
      minimatch(directoryPath, pattern, { dot: true })
    );
  });
}

/**
 * 计算归档目录相对于项目根的排除模式
 */
function computeArchiveExcludePattern(projectRoot: string, archiveRoot: string): string | null {
  const normalizedProject = normalize(resolve(projectRoot));
  const normalizedArchive = normalize(resolve(archiveRoot));
  if (!normalizedArchive.startsWith(normalizedProject)) {
    return null;
  }
  const rel = relative(normalizedProject, normalizedArchive);
  if (!rel || rel === '.') {
    return '.codekeeper/**';
  }
  return `${rel.replace(/\\/g, '/')}/**`;
}

/**
 * 读取项目配置，若文件不存在则返回默认配置
 * @param projectRoot 项目根目录
 * @param archiveRoot 归档位置；未提供时使用 projectRoot/.codekeeper
 */
export function loadProjectConfig(projectRoot: string, archiveRoot?: string): ProjectConfig {
  const configDir = archiveRoot
    ? normalize(resolve(archiveRoot))
    : join(projectRoot, '.codekeeper');
  const configPath = join(configDir, 'config.yaml');
  let config: ProjectConfig;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(raw);
    config = projectConfigSchema.parse(parsed);
  } catch (err) {
    // 仅对配置文件不存在的情况回退到默认配置；其他 IO 错误（如 EACCES）原样抛出
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      config = projectConfigSchema.parse({});
    } else {
      throw err;
    }
  }

  // 自动把归档目录加入排除列表，避免文件监控和扫描重复处理归档输出
  const archivePattern = computeArchiveExcludePattern(projectRoot, configDir);
  if (archivePattern && !config.exclude.includes(archivePattern)) {
    config.exclude.push(archivePattern);
  }

  for (const pattern of SYSTEM_PROJECT_EXCLUDE_PATTERNS) {
    if (!config.exclude.includes(pattern)) {
      config.exclude.push(pattern);
    }
  }

  return config;
}
