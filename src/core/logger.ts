import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { getLogDir } from './platform.js';

const LOG_DIR = process.env.CODEKEEPER_LOG_DIR || getLogDir();

// Ensure log directory exists
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // ignore
}

export const logger = pino({
  level: process.env.CODEKEEPER_LOG_LEVEL || 'info',
  transport: {
    targets: [
      {
        target: 'pino-pretty',
        level: 'info',
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
      {
        target: 'pino/file',
        level: 'debug',
        options: {
          destination: path.join(LOG_DIR, 'codekeeper.log'),
          mkdir: true,
        },
      },
    ],
  },
  redact: {
    paths: ['*.token', '*.apiKey', 'gitlab.token', 'gitlabToken', 'anthropicApiKey'],
    censor: '[REDACTED]',
  },
});
