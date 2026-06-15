import simpleGit, { SimpleGit } from 'simple-git';
import path from 'path';
import { logger } from './logger.js';
import type { ProjectConfig } from '../types.js';

export class ProjectSync {
  private git: SimpleGit;

  constructor(private project: ProjectConfig) {
    this.git = simpleGit(project.localPath);
  }

  /**
   * Fetch latest changes from remote
   */
  async sync(): Promise<void> {
    logger.info(`[${this.project.id}] Syncing project...`);

    try {
      await this.git.fetch(['origin', '--prune']);
      logger.info(`[${this.project.id}] Fetch completed`);
    } catch (err) {
      logger.error({ err }, `[${this.project.id}] Fetch failed`);
      throw err;
    }
  }

  /**
   * Get diff between target branch and source branch
   */
  async getDiff(targetBranch: string, sourceBranch: string): Promise<string> {
    const targetRef = `origin/${targetBranch}`;
    const sourceRef = `origin/${sourceBranch}`;

    logger.debug(`[${this.project.id}] Getting diff: ${targetRef}...${sourceRef}`);

    try {
      const diff = await this.git.diff([`${targetRef}...${sourceRef}`]);
      return diff;
    } catch (err) {
      // Fallback: try two-dot diff
      logger.warn(`[${this.project.id}] Three-dot diff failed, trying two-dot`);
      return await this.git.diff([`${targetRef}..${sourceRef}`]);
    }
  }

  /**
   * Get list of changed files
   */
  async getChangedFiles(targetBranch: string, sourceBranch: string): Promise<string[]> {
    const targetRef = `origin/${targetBranch}`;
    const sourceRef = `origin/${sourceBranch}`;

    const summary = await this.git.diffSummary([`${targetRef}...${sourceRef}`]);
    return summary.files.map(f => f.file);
  }

  /**
   * Create and checkout a new branch from source branch
   */
  async createBranch(branchName: string, fromBranch: string): Promise<void> {
    logger.info(`[${this.project.id}] Creating branch ${branchName} from ${fromBranch}`);

    // Ensure we're on a clean state on the from branch
    await this.git.fetch('origin', fromBranch);

    try {
      await this.git.checkoutBranch(branchName, `origin/${fromBranch}`);
    } catch (err) {
      // Branch might already exist locally
      logger.warn(`[${this.project.id}] checkoutBranch failed, trying checkout existing`);
      await this.git.checkout(branchName);
    }
  }

  /**
   * Commit changes with message
   */
  async commit(message: string): Promise<void> {
    await this.git.add('.');
    await this.git.commit(message);
  }

  /**
   * Push branch to remote
   */
  async push(branchName: string, force = false): Promise<void> {
    const args = ['origin', branchName];
    if (force) args.unshift('--force');
    await this.git.push(args);
    logger.info(`[${this.project.id}] Pushed ${branchName} to origin`);
  }

  /**
   * Get file content at path
   */
  async readFile(filePath: string): Promise<string> {
    const fullPath = path.join(this.project.localPath, filePath);
    const fs = await import('fs/promises');
    return fs.readFile(fullPath, 'utf8');
  }

  /**
   * Write file content
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    const fullPath = path.join(this.project.localPath, filePath);
    const fs = await import('fs/promises');
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf8');
  }

  /**
   * Check if working directory is clean
   */
  async isClean(): Promise<boolean> {
    const status = await this.git.status();
    return status.files.length === 0;
  }

  /**
   * Read project's CLAUDE.md rules
   */
  async loadClaudeMd(): Promise<string> {
    const rulesPath = path.join(this.project.localPath, this.project.review.rulesFile);
    const fs = await import('fs/promises');

    try {
      return await fs.readFile(rulesPath, 'utf8');
    } catch {
      logger.warn(`[${this.project.id}] ${this.project.review.rulesFile} not found, using default rules`);
      return this.getDefaultRules();
    }
  }

  private getDefaultRules(): string {
    return `
# Default Review Rules

## General
- Follow existing code style and patterns
- Avoid code duplication
- Use meaningful variable and function names
- Add error handling for async operations
- Keep functions focused and small
`;
  }
}
