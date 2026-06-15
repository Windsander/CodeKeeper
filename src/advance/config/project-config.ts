import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';

/**
 * 项目级 .codekeeper/config.yaml 的校验 schema
 */
export const projectConfigSchema = z.object({
  name: z.string().min(1).optional(),
  // 注意：name 未设置时由调用方（如 ProjectRegistry）回退到目录名
  include: z.array(z.string()).default([
    '**/*.md',
    '**/*.mdx',
    '**/*.txt',
    '**/*.json',
    '**/*.yaml',
    '**/*.yml',
    '**/*.toml',
    '**/*.ini',
    '**/*.ts',
    '**/*.tsx',
    '**/*.js',
    '**/*.jsx',
    '**/*.mjs',
    '**/*.cjs',
    '**/*.py',
    '**/*.rs',
    '**/*.go',
    '**/*.java',
    '**/*.kt',
    '**/*.swift',
    '**/*.c',
    '**/*.cpp',
    '**/*.h',
    '**/*.hpp',
    '**/*.cs',
    '**/*.php',
    '**/*.rb',
    '**/*.sh',
    '**/*.bash',
    '**/*.zsh',
    '**/*.ps1',
    '**/*.sql',
    '**/*.css',
    '**/*.scss',
    '**/*.less',
    '**/*.html',
    '**/*.htm',
    '**/*.xml',
    '**/*.svg',
  ]),
  exclude: z.array(z.string()).default(['node_modules/**', '.git/**', 'dist/**', '.codekeeper/drafts/**']),
  categories: z.array(z.string()).default([]),
  docTypes: z.array(z.string()).default([]),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

/**
 * 读取项目配置，若文件不存在则返回默认配置
 * @param projectRoot 项目根目录
 */
export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const configPath = join(projectRoot, '.codekeeper', 'config.yaml');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(raw);
    return projectConfigSchema.parse(parsed);
  } catch (err) {
    // 仅对配置文件不存在的情况回退到默认配置；其他 IO 错误（如 EACCES）原样抛出
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return projectConfigSchema.parse({});
    }
    throw err;
  }
}
