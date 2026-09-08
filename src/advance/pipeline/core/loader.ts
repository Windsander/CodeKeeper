/**
 * 管线定义 YAML 加载器。
 *
 * 正本位置：<project>/.codekeeper/pipeline.yaml
 * 人类可直接编辑该文件；画布编辑器读写同一文件。
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { pipelineWithSubgraphSchema, type PipelineDefinitionWithSubgraph } from './types.js';
import { PipelineDefinitionError } from './types.js';

/** 项目内管线定义正本的相对路径 */
export const PIPELINE_DEFINITION_RELATIVE_PATH = '.codekeeper/pipeline.yaml';

/** 解析 YAML 文本为管线定义；校验失败抛出 PipelineDefinitionError（聚合全部 issue）。 */
export function parsePipelineDefinition(text: string): PipelineDefinitionWithSubgraph {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PipelineDefinitionError('管线定义 YAML 解析失败', [message]);
  }

  const result = pipelineWithSubgraphSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`
    );
    throw new PipelineDefinitionError('管线定义不符合 schema', issues);
  }
  return result.data;
}

/** 从文件加载管线定义。文件不存在抛出 PipelineDefinitionError。 */
export function loadPipelineDefinition(filePath: string): PipelineDefinitionWithSubgraph {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PipelineDefinitionError(`管线定义文件不可读: ${filePath}`, [message]);
  }
  return parsePipelineDefinition(text);
}
