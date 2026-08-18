import type { ArchiverConfig } from '../../shared/types.js';

export function createDefaultArchiverConfig(): ArchiverConfig {
  return {
    role: 'archiver',
    schemaVersion: 3,
    archiverName: 'CodeKeeper Archiver',
    automation: {
      enabled: false,
      cron: '0 2 * * *',
    },
  };
}
