import cron from 'node-cron';
import { logger } from './core/logger.js';
import { runReview, runLearning } from './index.js';
import type { ProjectConfig } from './types.js';

interface ScheduledJob {
  task: string;
  job: cron.ScheduledTask;
}

const jobs: ScheduledJob[] = [];

/**
 * Start scheduler for all projects
 */
export function startScheduler(projects: ProjectConfig[]): void {
  logger.info(`Starting scheduler for ${projects.length} project(s)`);

  for (const project of projects) {
    if (project.review.enabled) {
      scheduleJob(
        `${project.id}-review`,
        project.review.schedule,
        project.review.timezone,
        () => runReview(project)
      );
    }

    if (project.learning.enabled) {
      scheduleJob(
        `${project.id}-learning`,
        project.learning.schedule,
        project.review.timezone,
        () => runLearning(project)
      );
    }
  }

  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, stopping scheduler...');
    stopAll();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    logger.info('Received SIGINT, stopping scheduler...');
    stopAll();
    process.exit(0);
  });

  logger.info('Scheduler running. Press Ctrl+C to stop.');

  // Keep process alive
  setInterval(() => {
    /* heartbeat */
  }, 60000);
}

/**
 * Schedule a single job
 */
function scheduleJob(
  name: string,
  schedule: string,
  timezone: string,
  fn: () => Promise<void>
): void {
  if (!cron.validate(schedule)) {
    logger.error(`Invalid cron expression for ${name}: ${schedule}`);
    return;
  }

  logger.info(`Scheduling ${name}: ${schedule} (timezone: ${timezone})`);

  const job = cron.schedule(
    schedule,
    async () => {
      logger.info(`[${name}] Job triggered`);
      try {
        await fn();
      } catch (err) {
        logger.error({ err }, `[${name}] Job failed`);
      }
    },
    {
      scheduled: true,
      timezone,
    }
  );

  jobs.push({ task: name, job });
}

/**
 * Stop all scheduled jobs
 */
export function stopAll(): void {
  for (const { task, job } of jobs) {
    logger.info(`Stopping job: ${task}`);
    job.stop();
  }
  jobs.length = 0;
}

/**
 * List active jobs
 */
export function listJobs(): string[] {
  return jobs.map((j) => j.task);
}
