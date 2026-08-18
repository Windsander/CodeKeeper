import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = join(workspaceRoot, 'tests');
const textExtensions = new Set([
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.snap',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);
const machinePaths = unique([workspaceRoot, homedir(), readGitDir(workspaceRoot)])
  .flatMap(pathVariants)
  .map(normalize);
const userDirectoryPatterns = [
  /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+/gi,
  /\/(?:home|Users)\/[^/\s"'`]+/g,
];
const violations = [];

for (const file of listTextFiles(testsRoot)) {
  const content = readFileSync(file, 'utf8');
  const searchable = normalize(content);
  const displayPath = relative(workspaceRoot, file).replaceAll('\\', '/');
  for (const machinePath of machinePaths) {
    const index = searchable.indexOf(machinePath);
    if (index >= 0) {
      violations.push({
        file: displayPath,
        line: lineNumberAt(searchable, index),
        reason: '包含当前机器的工作区、用户目录或 Git 元数据路径',
      });
    }
  }
  for (const pattern of userDirectoryPatterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      violations.push({
        file: displayPath,
        line: lineNumberAt(content, match.index ?? 0),
        reason: '包含平台用户目录形式的绝对路径',
      });
    }
  }
}

if (violations.length > 0) {
  console.error('测试路径隔离检查失败：');
  for (const violation of deduplicate(violations)) {
    console.error(`- ${violation.file}:${violation.line} ${violation.reason}`);
  }
  console.error('请使用动态临时目录，或用 virtual-* 相对路径表达纯路径语义。');
  process.exitCode = 1;
}

function listTextFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'vendor') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listTextFiles(path));
    else if (entry.isFile() && textExtensions.has(extname(entry.name).toLowerCase()))
      files.push(path);
  }
  return files;
}

function readGitDir(root) {
  const dotGit = join(root, '.git');
  try {
    if (!statSync(dotGit).isFile()) return '';
    const value = /^gitdir:\s*(.+)$/im.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    if (!value) return '';
    return isAbsolute(value) ? value : resolve(root, value);
  } catch {
    return '';
  }
}

function pathVariants(path) {
  const slashPath = path.replaceAll('\\', '/');
  const variants = new Set([
    path,
    slashPath,
    path.replaceAll('\\', '\\\\'),
    slashPath.replaceAll('/', '\\\\'),
  ]);
  const drive = /^([A-Za-z]):\/(.*)$/.exec(slashPath);
  if (drive) variants.add(`/mnt/${drive[1].toLowerCase()}/${drive[2]}`);
  return [...variants];
}

function unique(values) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function normalize(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function deduplicate(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.file}:${item.line}:${item.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
