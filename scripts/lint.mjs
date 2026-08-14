import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const eslintCli = resolve('node_modules/eslint/bin/eslint.js');
const checks = [
  {
    args: [eslintCli, 'src', '--ext', 'ts'],
    env: { ...process.env, ESLINT_USE_FLAT_CONFIG: 'false' },
  },
  { args: [resolve('scripts/check-test-path-hygiene.mjs')], env: process.env },
];

for (const check of checks) {
  const result = spawnSync(process.execPath, check.args, {
    env: check.env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`Failed to start lint check: ${result.error.message}`);
    process.exitCode = 1;
    break;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
