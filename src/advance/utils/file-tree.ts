import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface FileTreeNode {
  name: string;
  path: string;
  relPath: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
}

/**
 * 递归读取目录，返回文件树结构
 */
export function readDirectoryTree(dir: string, rootDir = dir): FileTreeNode {
  const name = dir === rootDir ? '归档根目录' : relative(rootDir, dir).replace(/\\/g, '/');
  const stat = statSync(dir);
  if (!stat.isDirectory()) {
    return {
      name,
      path: dir,
      relPath: relative(rootDir, dir).replace(/\\/g, '/'),
      type: 'file',
    };
  }

  const entries = readdirSync(dir);
  const children: FileTreeNode[] = [];

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const fullPath = join(dir, entry);
    const childStat = statSync(fullPath);
    if (childStat.isDirectory()) {
      children.push(readDirectoryTree(fullPath, rootDir));
    } else {
      children.push({
        name: entry,
        path: fullPath,
        relPath: relative(rootDir, fullPath).replace(/\\/g, '/'),
        type: 'file',
      });
    }
  }

  // 目录在前，文件在后，均按名称排序
  children.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'directory' ? -1 : 1;
  });

  return {
    name,
    path: dir,
    relPath: dir === rootDir ? '' : relative(rootDir, dir).replace(/\\/g, '/'),
    type: 'directory',
    children,
  };
}
