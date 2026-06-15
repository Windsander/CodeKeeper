import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ContextEntry {
  filePath: string;
  category: string;
  docType: string;
  summary: string;
  tags: string[];
}

export interface ContextGeneratorOptions {
  projectRoot: string;
  projectName: string;
  entries: ContextEntry[];
}

/**
 * 生成 .codekeeper/context.md，按 category 分组展示知识条目
 */
export function generateContext(options: ContextGeneratorOptions): void {
  const dir = join(options.projectRoot, '.codekeeper');
  mkdirSync(dir, { recursive: true });

  const byCategory = new Map<string, ContextEntry[]>();
  for (const entry of options.entries) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }

  const lines: string[] = [`# ${options.projectName} 知识上下文`, '', `> 自动生成于 ${new Date().toISOString()}`, ''];

  for (const [category, items] of byCategory) {
    lines.push(`## ${category}`);
    for (const item of items) {
      lines.push(`- **${item.docType}** [${item.filePath}] — ${item.summary}`);
      if (item.tags.length > 0) {
        lines.push(`  - 标签：${item.tags.join(', ')}`);
      }
    }
    lines.push('');
  }

  writeFileSync(join(dir, 'context.md'), lines.join('\n'), 'utf-8');
}
