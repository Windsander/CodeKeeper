import { basename, dirname, extname, join, relative } from 'node:path';

export interface ComputeArchivePathParams {
  archiveRoot: string;
  sourcePath: string;
  category: string;
  docType: string;
  date?: Date;
  existingPaths?: Set<string>;
}

/**
 * 根据分类、文档类型、日期，计算文件在归档根目录中的目标路径
 */
export function computeArchivePath(params: ComputeArchivePathParams): string {
  const { archiveRoot, sourcePath, category, docType, date, existingPaths } = params;

  const safeCategory = sanitizePathSegment(category);
  const safeDocType = sanitizePathSegment(docType);
  const fileDate = date ?? new Date();
  const yearMonth = `${fileDate.getFullYear()}-${String(fileDate.getMonth() + 1).padStart(2, '0')}`;
  const safeName = sanitizeFileName(basename(sourcePath));

  let archivePath = join(archiveRoot, safeCategory, safeDocType, yearMonth, safeName);

  if (existingPaths) {
    let counter = 1;
    const ext = extname(safeName);
    const nameWithoutExt = basename(safeName, ext);
    while (existingPaths.has(archivePath.toLowerCase())) {
      archivePath = join(archiveRoot, safeCategory, safeDocType, yearMonth, `${nameWithoutExt}_${counter}${ext}`);
      counter++;
    }
  }

  return archivePath;
}

export function computeFlaggedArchivePath(params: ComputeArchivePathParams): string {
  const base = computeArchivePath(params);
  return toFlaggedArchivePath(base);
}

/** 将已计算的标准归档路径转换为同层 flagged 子目录路径。 */
export function toFlaggedArchivePath(archivePath: string): string {
  return join(dirname(archivePath), 'flagged', basename(archivePath));
}

export function sanitizePathSegment(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    || 'unknown';
}

export function sanitizeFileName(name: string): string {
  return name
    .replace(new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g'), '') // eslint-disable-line no-control-regex
    .replace(new RegExp('[\\u003c\\u003e\\u0022\\u002f\\u005c\\u007c\\u003f\\u002a]', 'g'), '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_');
}

/**
 * 检查路径是否在归档根目录内
 */
export function isWithinArchiveRoot(archiveRoot: string, filePath: string): boolean {
  const rel = relative(archiveRoot, filePath);
  return !rel.startsWith('..') && rel !== filePath;
}
