import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProjectConfig } from '../../src/advance/config/project-config';
import { scanExistingFiles } from '../../src/advance/project-scanner';
import { MetadataStore } from '../../src/advance/store/metadata-store';
import type { Project } from '../../src/advance/types';

describe('scanExistingFiles', () => {
  let tempRoot: string;
  let projectRoot: string;
  let archiveRoot: string;
  let store: MetadataStore;
  let project: Project;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'ck-scan-'));
    projectRoot = join(tempRoot, 'project');
    archiveRoot = join(tempRoot, 'archive');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(archiveRoot, { recursive: true });
    store = new MetadataStore(join(tempRoot, 'metadata.db'));
    project = {
      id: 'virtual-project-id',
      rootPath: projectRoot,
      archiveRoot,
      name: 'virtual-project',
      registeredAt: 1,
      lastScannedAt: null,
    };
    store.registerProject(project);
  });

  afterEach(() => {
    store.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('应忽略嵌套依赖与解包产物中的文档', async () => {
    writeProjectFile('docs/guide.md');
    writeProjectFile('packages/feature/node_modules/dependency/README.md');
    writeProjectFile('packages/feature/dist/README.md');
    writeProjectFile('release/win-unpacked/resources/README.md');
    writeProjectFile(
      'release/win-unpacked/resources/extensions/sample/node_modules/dependency/CHANGELOG.md'
    );

    const addedCount = await scanExistingFiles(
      store,
      project,
      loadProjectConfig(projectRoot, archiveRoot)
    );
    const pendingPaths = store
      .listPendingEvents(20)
      .map(event => relative(projectRoot, event.filePath).replace(/\\/g, '/'));

    expect(addedCount).toBe(1);
    expect(pendingPaths).toEqual(['docs/guide.md']);
  });

  function writeProjectFile(relativePath: string): void {
    const filePath = join(projectRoot, relativePath);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, '# virtual document', 'utf8');
  }
});
