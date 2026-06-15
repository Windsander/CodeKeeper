import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchiveAction } from '../types';

export interface SuggestionsWriterOptions {
  projectRoot: string;
  actions: ArchiveAction[];
}

/**
 * 将未执行的中高风险归档建议写入 .codekeeper/suggestions.md
 */
export function writeSuggestions(options: SuggestionsWriterOptions): void {
  const dir = join(options.projectRoot, '.codekeeper');
  mkdirSync(dir, { recursive: true });

  const lines: string[] = [
    '# 归档建议',
    '',
    `> 生成时间：${new Date().toISOString()}`,
    `> 待处理建议数：${options.actions.length}`,
    '',
  ];

  if (options.actions.length === 0) {
    lines.push('当前没有待处理的归档建议。');
  } else {
    for (const action of options.actions) {
      lines.push(`## ${action.sourcePath}`);
      lines.push(`- 建议动作：${action.type}`);
      lines.push(`- 风险等级：${action.risk}`);
      lines.push(`- 置信度：${action.confidence}`);
      lines.push(`- 理由：${action.reason}`);
      if (action.targetPath) lines.push(`- 目标路径：${action.targetPath}`);
      if (action.relatedEntryId) lines.push(`- 关联条目：${action.relatedEntryId}`);
      lines.push('');
    }
  }

  writeFileSync(join(dir, 'suggestions.md'), lines.join('\n'), 'utf-8');
}
