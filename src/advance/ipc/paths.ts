import { homedir } from 'node:os';
import { join } from 'node:path';

export function getIpcSocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\?\\pipe\\codekeeper-advance-daemon';
  }
  return join(homedir(), '.codekeeper-advance', 'daemon.sock');
}
