import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';

/**
 * 项目级 .codekeeper/config.yaml 的校验 schema
 */
export const projectConfigSchema = z.object({
  name: z.string().min(1).optional(),
  include: z.array(z.string()).default(['**/*.md', '**/*.ts', '**/*.json']),
  exclude: z.array(z.string()).default(['node_modules/**', '.git/**', 'dist/**', '.codekeeper/drafts/**']),
  categories: z.array(z.string()).default([]),
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
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return projectConfigSchema.parse({});
    }
    throw err;
  }
}
