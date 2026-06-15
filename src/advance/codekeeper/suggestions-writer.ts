import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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

  const byRisk = groupByRisk(options.actions);
  const riskOrder: ArchiveAction['risk'][] = ['high', 'medium'];

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
    // 批量操作脚本
    lines.push('## 批量操作');
    lines.push('');
    lines.push('```bash');
    lines.push('# 接受所有 low risk 建议（当前没有需要手动审查的 low risk，此处仅作示例）');
    lines.push('# codekeeper-advance process --api-key <YOUR_KEY> <PROJECT_PATH>');
    lines.push('```');
    lines.push('');

    for (const risk of riskOrder) {
      const actions = byRisk.get(risk) ?? [];
      if (actions.length === 0) continue;
      lines.push(`## ${riskLabel(risk)} 风险（${actions.length}）`);
      lines.push('');
      for (const action of actions) {
        const relSource = relative(options.projectRoot, action.sourcePath).replace(/\\/g, '/');
        lines.push(`### ${relSource}`);
        lines.push(`- ID：${action.id}`);
        lines.push(`- 建议动作：${action.type}`);
        lines.push(`- 风险等级：${action.risk}`);
        lines.push(`- 置信度：${action.confidence}`);
        lines.push(`- 理由：${action.reason}`);
        if (action.targetPath) {
          const relTarget = relative(options.projectRoot, action.targetPath).replace(/\\/g, '/');
          lines.push(`- 目标路径：${relTarget}`);
        }
        if (action.relatedEntryId) lines.push(`- 关联条目：${action.relatedEntryId}`);
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
  // 每组内按置信度降序
  for (const [, list] of map) {
    list.sort((a, b) => b.confidence - a.confidence);
  }
  return map;
}

function riskLabel(risk: ArchiveAction['risk']): string {
  const map = { high: '高', medium: '中', low: '低' };
  return map[risk];
}
