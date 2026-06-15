#!/usr/bin/env node
import 'dotenv/config';
import { loadConfig } from './config-loader.js';
import { logger } from './core/logger.js';
import { runReview, runLearning } from './index.js';
import { startScheduler, stopAll, listJobs } from './scheduler.js';

const args = process.argv.slice(2);
const command = args[0] || 'run';

function showHelp(): void {
  console.log(`
CodeKeeper — Code Orchestrator & Review Node

Usage:
  codekeeper <command> [options]

Commands:
  run                   Run review + learning once for all projects
  review                Run review only
  learn                 Run learning loop only
  daemon                Start scheduler daemon (cron mode)
  status                Show scheduler status
  stop                  Stop daemon (sends SIGTERM)
  register <path>       Register a new project from local path
  validate              Validate all project configs

Options:
  --project=<id>        Target specific project
  --config=<path>       Use custom config file
  --daemon              Run in daemon mode (with 'run' command)

Examples:
  codekeeper run                          # Single run for all projects
  codekeeper run --project=my-project     # Single run for one project
  codekeeper review                       # Review only
  codekeeper daemon                       # Start background scheduler
  codekeeper register ./my-project        # Auto-register project
`);
}

async function main(): Promise<void> {
  const projectArg = args.find((arg) => arg.startsWith('--project='));
  const configPath = args.find((arg) => arg.startsWith('--config='));
  const isDaemon = args.includes('--daemon');

  let config;
  try {
    config = loadConfig(configPath?.split('=')[1]);
  } catch (err) {
    console.error('Failed to load config:', (err as Error).message);
    process.exit(1);
  }

  // Filter projects
  let projects = config.projects;
  if (projectArg) {
    const projectId = projectArg.split('=')[1];
    projects = projects.filter((p) => p.id === projectId);
    if (projects.length === 0) {
      console.error(`Project "${projectId}" not found`);
      process.exit(1);
    }
  }

  switch (command) {
    case 'run': {
      if (isDaemon) {
        startScheduler(projects);
      } else {
        for (const project of projects) {
          if (project.review.enabled) await runReview(project);
          if (project.learning.enabled) await runLearning(project);
        }
        logger.info('Run complete');
      }
      break;
    }

    case 'review': {
      for (const project of projects) {
        if (project.review.enabled) await runReview(project);
      }
      break;
    }

    case 'learn': {
      for (const project of projects) {
        if (project.learning.enabled) await runLearning(project);
      }
      break;
    }

    case 'daemon': {
      startScheduler(projects);
      break;
    }

    case 'status': {
      const jobs = listJobs();
      if (jobs.length === 0) {
        console.log('No active scheduled jobs');
      } else {
        console.log('Active jobs:');
        for (const job of jobs) {
          console.log(`  - ${job}`);
        }
      }
      break;
    }

    case 'stop': {
      stopAll();
      logger.info('Scheduler stopped');
      break;
    }

    case 'validate': {
      let hasErrors = false;
      for (const project of projects) {
        const { validateProject } = await import('./config-loader.js');
        const errors = validateProject(project);
        if (errors.length === 0) {
          console.log(`✅ ${project.id}: valid`);
        } else {
          console.log(`❌ ${project.id}:`);
          for (const err of errors) {
            console.log(`   - ${err}`);
          }
          hasErrors = true;
        }
      }
      if (hasErrors) process.exit(1);
      break;
    }

    case 'register': {
      const projectPath = args[1];
      if (!projectPath) {
        console.error('Usage: codekeeper register <path>');
        process.exit(1);
      }
      console.log('Auto-register not yet implemented. Please manually edit config/projects.yaml');
      break;
    }

    case 'help':
    case '--help':
    case '-h':
    default:
      showHelp();
      break;
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'CLI error');
  process.exit(1);
});
