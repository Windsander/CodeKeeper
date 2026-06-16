import { createHash } from 'node:crypto';
import { normalize, resolve } from 'node:path';
import type { MetadataStore } from './store/metadata-store';
import type { Project } from './types';
import { loadProjectConfig } from './config/project-config';

export function makeProjectId(rootPath: string): string {
  const crossPlatformPath = rootPath.replace(/\\/g, '/');
  return createHash('sha256').update(crossPlatformPath).digest('hex').slice(0, 16);
}

export interface ProjectRegistryDeps {
  store: MetadataStore;
}

export class ProjectRegistry {
  constructor(private deps: ProjectRegistryDeps) {}

  register(rootPath: string, archiveRoot?: string): Project {
    const normalized = normalize(resolve(rootPath));
    const config = loadProjectConfig(normalized, archiveRoot);
    const id = makeProjectId(normalized);
    const project: Project = {
      id,
      rootPath: normalized,
      archiveRoot: archiveRoot ? normalize(resolve(archiveRoot)) : undefined,
      name: config.name ?? normalized.split(/[\\/]/).pop() ?? id,
      registeredAt: Date.now(),
      lastScannedAt: null,
    };
    this.deps.store.registerProject(project);
    return project;
  }

  unregister(projectId: string): void {
    this.deps.store.unregisterProject(projectId);
  }

  list(): Project[] {
    return this.deps.store.listProjects();
  }

  get(projectId: string): Project | null {
    return this.deps.store.getProject(projectId);
  }
}
