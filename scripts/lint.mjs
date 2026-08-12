import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const eslintCli = resolve('node_modules/eslint/bin/eslint.js');
const result = spawnSync(process.execPath, [eslintCli, 'src', '--ext', 'ts'], {
  env: {
    ...process.env,
    ESLINT_USE_FLAT_CONFIG: 'false',
  },
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Failed to start ESLint: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
