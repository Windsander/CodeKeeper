import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ArchiveAction } from '../types';

export interface SuggestionsWriterOptions {
  projectRoot: string;
  archiveRoot: string;
  actions: ArchiveAction[];
}

/**
 * 将归档动作历史写入归档位置的 suggestions.md
 * 在图书管理员模式下，这不是待处理队列，而是供人工 review 的动作日志。
 */
export function writeSuggestions(options: SuggestionsWriterOptions): void {
  const dir = options.archiveRoot;
  mkdirSync(dir, { recursive: true });

  const byRisk = groupByRisk(options.actions);
  const riskOrder: ArchiveAction['risk'][] = ['high', 'medium', 'low'];

  const lines: string[] = [
    '# 归档动作日志',
    '',
    `> 生成时间：${new Date().toISOString()}`,
    `> 总动作数：${options.actions.length}`,
    '> 说明：原始文件不会被修改，所有动作仅在归档目录内执行。',
    '',
  ];

  if (options.actions.length === 0) {
    lines.push('当前没有归档动作记录。');
  } else {
    for (const risk of riskOrder) {
      const actions = byRisk.get(risk) ?? [];
      if (actions.length === 0) continue;
      lines.push(`## ${riskLabel(risk)} 风险（${actions.length}）`);
      lines.push('');
      for (const action of actions) {
        const relSource = relative(options.projectRoot, action.sourcePath).replace(/\\/g, '/');
        lines.push(`### ${relSource}`);
        lines.push(`- ID：${action.id}`);
        lines.push(`- 动作：${action.type}`);
        lines.push(`- 风险等级：${action.risk}`);
        lines.push(`- 置信度：${action.confidence.toFixed(2)}`);
        lines.push(`- 理由：${action.reason}`);
        if (action.targetPath) {
          const relTarget = relative(options.archiveRoot, action.targetPath).replace(/\\/g, '/');
          lines.push(`- 归档路径：${relTarget}`);
        }
        if (action.relatedEntryId) lines.push(`- 关联条目：${action.relatedEntryId}`);
        lines.push(`- 时间：${new Date(action.createdAt).toISOString()}`);
        lines.push('');
      }
    }
  }

  writeFileSync(join(dir, 'suggestions.md'), lines.join('\n'), 'utf-8');
}

function groupByRisk(actions: ArchiveAction[]): Map<ArchiveAction['risk'], ArchiveAction[]> {
  const map = new Map<ArchiveAction['risk'], ArchiveAction[]>();
  for (const action of actions) {
    const list = map.get(action.risk) ?? [];
    list.push(action);
    map.set(action.risk, list);
  }
  // 每组内按时间降序
  for (const [, list] of map) {
    list.sort((a, b) => b.createdAt - a.createdAt);
  }
  return map;
}

function riskLabel(risk: ArchiveAction['risk']): string {
  const map = { high: '高', medium: '中', low: '低' };
  return map[risk];
}
