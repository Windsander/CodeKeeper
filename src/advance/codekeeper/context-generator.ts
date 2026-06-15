import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface ContextEntry {
  filePath: string;
  category: string;
  docType: string;
  summary: string;
  tags: string[];
  /** 条目状态 */
  status?: 'pending' | 'archived' | 'ignored';
  /** 更新时间戳 */
  updatedAt?: number;
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

  // 稳定排序：category 按字母序，条目按 filePath 字母序
  const sortedCategories = Array.from(byCategory.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [, items] of sortedCategories) {
    items.sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  const lines: string[] = [
    `# ${options.projectName} 知识上下文`,
    '',
    `> 自动生成于 ${new Date().toISOString()}`,
    '',
  ];

  if (sortedCategories.length === 0) {
    lines.push('当前暂无已归档知识条目。');
    lines.push('');
  } else {
    // 目录
    lines.push('## 目录');
    for (const [category] of sortedCategories) {
      lines.push(`- [${category}](#${anchor(category)})`);
    }
    lines.push('');

    for (const [category, items] of sortedCategories) {
      lines.push(`## ${category}`);
      lines.push('');
      for (const item of items) {
        const relPath = relative(options.projectRoot, item.filePath).replace(/\\/g, '/');
        const statusBadge = item.status ? ` (${statusLabel(item.status)})` : '';
        lines.push(`- **${item.docType}** [${relPath}](${encodePath(relPath)})${statusBadge} — ${item.summary}`);
        if (item.tags.length > 0) {
          lines.push(`  - 标签：${item.tags.join(', ')}`);
        }
        if (item.updatedAt) {
          lines.push(`  - 更新：${new Date(item.updatedAt).toISOString()}`);
        }
      }
      lines.push('');
    }
  }

  writeFileSync(join(dir, 'context.md'), lines.join('\n'), 'utf-8');
}

function anchor(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9一-龥-]/g, '');
}

function encodePath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

function statusLabel(status: 'pending' | 'archived' | 'ignored'): string {
  const map = { pending: '待处理', archived: '已归档', ignored: '已忽略' };
  return map[status];
}
