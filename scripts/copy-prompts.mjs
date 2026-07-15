/**
 * 构建步骤：将 src/assets/prompts 拷贝到 dist/assets/prompts
 *
 * 与 copy-schema 保持一致，确保编译后的代码能读取 prompt 资产。
 * 使用手动递归拷贝，避免 Node fs.cpSync 在 WSL drvfs 上因权限/属性问题抛 EPERM。
 */

import { readdirSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, '..', 'src', 'assets', 'prompts');
const dest = join(__dirname, '..', 'dist', 'assets', 'prompts');

function copyDir(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      writeFileSync(destPath, readFileSync(srcPath));
    }
  }
}

rmSync(dest, { recursive: true, force: true });
copyDir(src, dest);

console.log(`已拷贝 prompts: ${src} -> ${dest}`);
