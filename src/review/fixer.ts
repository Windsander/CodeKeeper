import { logger } from '../core/logger.js';
import { ProjectSync } from '../core/project-sync.js';
import { Reviewer } from './reviewer.js';
import type { ProjectConfig, MergeRequest, ReviewFinding } from '../types.js';

export class Fixer {
  private projectSync: ProjectSync;
  private reviewer: Reviewer;

  constructor(private project: ProjectConfig) {
    this.projectSync = new ProjectSync(project);
    this.reviewer = new Reviewer(project);
  }

  /**
   * Apply automatic fixes for a review result
   */
  async applyFixes(mr: MergeRequest, findings: ReviewFinding[], autoFixableIndices: number[]): Promise<{
    branchName: string;
    fixedCount: number;
    failedCount: number;
  } | null> {
    if (!this.project.review.autoFix || autoFixableIndices.length === 0) {
      logger.info(`[${this.project.id}] MR !${mr.iid}: autoFix disabled or no fixable issues`);
      return null;
    }

    const branchName = `${this.project.review.autoFixBranchPrefix}${mr.iid}-${Date.now()}`;
    logger.info(`[${this.project.id}] MR !${mr.iid}: Creating fix branch ${branchName}`);

    try {
      // Create branch from source branch
      await this.projectSync.createBranch(branchName, mr.sourceBranch);

      let fixedCount = 0;
      let failedCount = 0;
      const fixedFiles = new Set<string>();

      for (const idx of autoFixableIndices) {
        const finding = findings[idx];
        if (!finding) continue;

        // Skip if already fixed this file (avoid conflicts)
        if (fixedFiles.has(finding.file)) {
          logger.debug(`[${this.project.id}] Skipping ${finding.file}: already modified`);
          continue;
        }

        const success = await this.applySingleFix(finding);
        if (success) {
          fixedCount++;
          fixedFiles.add(finding.file);
        } else {
          failedCount++;
        }
      }

      if (fixedCount === 0) {
        logger.info(`[${this.project.id}] MR !${mr.iid}: No fixes applied, discarding branch`);
        await this.discardBranch(branchName);
        return null;
      }

      // Validate fixes
      const valid = await this.validateFixes();
      if (!valid) {
        logger.warn(`[${this.project.id}] MR !${mr.iid}: Validation failed, discarding branch`);
        await this.discardBranch(branchName);
        return null;
      }

      // Commit and push
      await this.projectSync.commit(`fix: auto-fix review comments from !${mr.iid}\n\nApplied ${fixedCount} fix(es).`);
      await this.projectSync.push(branchName);

      logger.info(`[${this.project.id}] MR !${mr.iid}: Pushed ${fixedCount} fix(es) to ${branchName}`);

      return { branchName, fixedCount, failedCount };
    } catch (err) {
      logger.error({ err }, `[${this.project.id}] MR !${mr.iid}: Fix application failed`);
      // Cleanup
      try {
        await this.discardBranch(branchName);
      } catch {
        // ignore cleanup error
      }
      return null;
    }
  }

  /**
   * Apply a single fix
   */
  private async applySingleFix(finding: ReviewFinding): Promise<boolean> {
    try {
      logger.info(`[${this.project.id}] Fixing ${finding.file}:${finding.line}`);

      const fixedContent = await this.reviewer.generateFix(finding.file, finding);
      if (!fixedContent) {
        logger.warn(`[${this.project.id}] No fix generated for ${finding.file}`);
        return false;
      }

      await this.projectSync.writeFile(finding.file, fixedContent);
      logger.info(`[${this.project.id}] Applied fix to ${finding.file}`);
      return true;
    } catch (err) {
      logger.error({ err, file: finding.file }, 'Failed to apply fix');
      return false;
    }
  }

  /**
   * Validate fixes by running project lint/typecheck
   */
  private async validateFixes(): Promise<boolean> {
    const validators = [
      { cmd: 'npm run lint', name: 'lint' },
      { cmd: 'npm run typecheck', name: 'typecheck' },
    ];

    for (const validator of validators) {
      try {
        logger.debug(`[${this.project.id}] Running ${validator.name}...`);
        const { execSync } = await import('child_process');
        execSync(validator.cmd, {
          cwd: this.project.localPath,
          stdio: 'pipe',
          timeout: 120000,
        });
        logger.info(`[${this.project.id}] ${validator.name} passed`);
      } catch (err) {
        logger.warn({ err }, `[${this.project.id}] ${validator.name} failed, discarding fixes`);
        return false;
      }
    }

    return true;
  }

  /**
   * Discard a branch and return to default branch
   */
  private async discardBranch(branchName: string): Promise<void> {
    const { simpleGit } = await import('simple-git');
    const git = simpleGit(this.project.localPath);
    try {
      await git.checkout(this.project.git.defaultBranch);
      await git.deleteLocalBranch(branchName, true);
    } catch {
      // ignore cleanup errors
    }
  }
}
