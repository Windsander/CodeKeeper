import 'dotenv/config';
import { loadConfig, validateProject } from './config-loader.js';
import { logger } from './core/logger.js';
import { ProjectSync } from './core/project-sync.js';
import { MRService } from './gitlab/mr-service.js';
import { Reviewer } from './review/reviewer.js';
import { Fixer } from './review/fixer.js';
import { PatternTracker } from './learn/pattern-tracker.js';
import { ClaudeMdUpdater } from './learn/claude-md-updater.js';
import { AstGrepGenerator } from './learn/ast-grep-generator.js';
import type { ProjectConfig } from './types.js';

export async function runReview(project: ProjectConfig): Promise<void> {
  logger.info(`[${project.id}] === Starting review cycle ===`);

  const errors = validateProject(project);
  if (errors.length > 0) {
    logger.error({ errors }, `[${project.id}] Project validation failed`);
    return;
  }

  // Sync project
  const projectSync = new ProjectSync(project);
  try {
    await projectSync.sync();
  } catch (err) {
    logger.error({ err }, `[${project.id}] Project sync failed`);
    return;
  }

  // Get reviewable MRs
  const mrService = new MRService(project);
  const mrs = await mrService.getReviewableMRs();

  if (mrs.length === 0) {
    logger.info(`[${project.id}] No MRs to review`);
    return;
  }

  // Review each MR
  const reviewer = new Reviewer(project);
  const fixer = new Fixer(project);

  for (const mr of mrs) {
    try {
      const result = await reviewer.reviewMR(mr);

      // Apply fixes if enabled
      if (result.autoFixable.length > 0) {
        const fixResult = await fixer.applyFixes(mr, result.findings, result.autoFixable);
        if (fixResult) {
          logger.info(
            `[${project.id}] MR !${mr.iid}: Created fix branch ${fixResult.branchName} ` +
              `(${fixResult.fixedCount} fixed, ${fixResult.failedCount} failed)`
          );
        }
      }
    } catch (err) {
      logger.error({ err }, `[${project.id}] MR !${mr.iid}: Review failed`);
    }
  }

  logger.info(`[${project.id}] === Review cycle complete ===`);
}

export async function runLearning(project: ProjectConfig): Promise<void> {
  logger.info(`[${project.id}] === Starting learning cycle ===`);

  if (!project.learning.enabled) {
    logger.info(`[${project.id}] Learning disabled`);
    return;
  }

  const mrService = new MRService(project);
  const patternTracker = new PatternTracker(project);
  const claudeMdUpdater = new ClaudeMdUpdater(project);
  const astGrepGenerator = new AstGrepGenerator(project);

  // Get recently merged MRs
  const mergedMRs = await mrService.getRecentlyMergedMRs(project.learning.lookbackDays);
  logger.info(`[${project.id}] Found ${mergedMRs.length} recently merged MRs`);

  for (const mr of mergedMRs) {
    try {
      // Get reviewer comments
      const comments = await mrService.getReviewerComments(mr.iid);

      if (comments.length === 0) {
        continue;
      }

      logger.info(`[${project.id}] MR !${mr.iid}: ${comments.length} reviewer comments`);

      // Process and track patterns
      const triggered = await patternTracker.processComments(comments);

      // Handle triggered patterns
      for (const category of triggered) {
        const patterns = await patternTracker.getPatterns();
        const pattern = patterns.find((p) => p.category === category);
        if (!pattern) continue;

        logger.info(
          `[${project.id}] Pattern "${category}" reached threshold (${pattern.count})`
        );

        // Update CLAUDE.md
        const updated = await claudeMdUpdater.appendRule(category, pattern);

        // Generate ast-grep rule
        const rulePath = await astGrepGenerator.generateRule(category, pattern);

        // Reset counter
        if (updated || rulePath) {
          await patternTracker.resetPattern(category);
          logger.info(`[${project.id}] Pattern "${category}" processed and reset`);
        }
      }
    } catch (err) {
      logger.error({ err }, `[${project.id}] MR !${mr.iid}: Learning failed`);
    }
  }

  logger.info(`[${project.id}] === Learning cycle complete ===`);
}

// Main entry point
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isDaemon = args.includes('--daemon');
  const projectArg = args.find((arg) => arg.startsWith('--project='));
  const configPath = args.find((arg) => arg.startsWith('--config='));

  let config;
  try {
    config = loadConfig(configPath?.split('=')[1]);
  } catch (err) {
    logger.error({ err }, 'Failed to load config');
    process.exit(1);
  }

  // Filter projects if --project specified
  let projects = config.projects;
  if (projectArg) {
    const projectId = projectArg.split('=')[1];
    projects = projects.filter((p) => p.id === projectId);
    if (projects.length === 0) {
      logger.error(`Project "${projectId}" not found in config`);
      process.exit(1);
    }
  }

  if (isDaemon) {
    logger.info('Starting CodeKeeper in daemon mode...');
    const { startScheduler } = await import('./scheduler.js');
    startScheduler(projects);
  } else {
    // Single run: review + learning for all projects
    for (const project of projects) {
      if (project.review.enabled) {
        await runReview(project);
      }
      if (project.learning.enabled) {
        await runLearning(project);
      }
    }
    logger.info('CodeKeeper run complete');
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'Unhandled error');
  process.exit(1);
});
