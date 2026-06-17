import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

/**
 * 全平台测试入口。
 * 在 WSL 环境下自动调用 Windows PowerShell 运行 vitest，规避 rolldown 等原生绑定问题。
 */

function isWsl() {
  if (process.platform !== 'linux') return false;
  try {
    const release = readFileSync('/proc/sys/kernel/osrelease', 'utf8').toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

function runVitest() {
  execSync('npm run test:vitest', { stdio: 'inherit' });
}

function runInPowerShell(winPath) {
  const command = `cd '${winPath}'; npm run test:vitest`;
  const shells = ['powershell.exe', 'pwsh'];
  let lastErr;
  for (const shell of shells) {
    try {
      execSync(`${shell} -NoProfile -Command "${command}"`, { stdio: 'inherit' });
      return;
    } catch (err) {
      lastErr = err;
      // 尝试下一个 shell
    }
  }
  throw lastErr ?? new Error('未找到可用的 PowerShell（powershell.exe / pwsh）');
}

if (isWsl()) {
  const cwd = process.cwd();
  const winPath = execSync(`wslpath -w "${cwd}"`, { encoding: 'utf8' }).trim();
  console.log('[test] 检测到 WSL 环境，尝试通过 PowerShell 在 Windows 侧运行测试...');
  try {
    runInPowerShell(winPath);
  } catch (err) {
    console.warn(`[test] ${err.message}，回退到当前环境直接运行。`);
    runVitest();
  }
} else {
  runVitest();
}
