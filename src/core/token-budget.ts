import type { MrDiff, DiffChunk, TokenBudget } from '../types.js';
import { logger } from './logger.js';

// Token estimation constants (empirical, based on typical code density)
const TOKENS_PER_CHAR = 0.25; // ~4 chars per token for code
const SYSTEM_PROMPT_TOKENS = 1000;
const CLAUDE_MD_OVERHEAD = 5000; // Average CLAUDE.md size in tokens
const OUTPUT_RESERVE = 20000; // Reserve for AI response
const SAFETY_MARGIN = 0.8; // Use only 80% of budget to leave room

/**
 * Estimate token count for a string
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

/**
 * Calculate available token budget for diff review
 */
export function calculateDiffBudget(totalBudget: number): number {
  const available = totalBudget - SYSTEM_PROMPT_TOKENS - CLAUDE_MD_OVERHEAD - OUTPUT_RESERVE;
  return Math.floor(available * SAFETY_MARGIN);
}

/**
 * Parse unified diff into structured MrDiff entries
 */
export function parseDiff(unifiedDiff: string): MrDiff[] {
  const files: MrDiff[] = [];
  const lines = unifiedDiff.split('\n');

  let currentFile: Partial<MrDiff> | null = null;
  let diffLines: string[] = [];

  for (const line of lines) {
    // Detect file header: diff --git a/old b/new
    const gitDiffMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (gitDiffMatch) {
      if (currentFile) {
        finalizeFile(currentFile as MrDiff, diffLines);
        files.push(currentFile as MrDiff);
      }
      currentFile = {
        oldPath: gitDiffMatch[1],
        newPath: gitDiffMatch[2],
        filePath: gitDiffMatch[2],
        diff: '',
        additions: 0,
        deletions: 0,
      };
      diffLines = [];
      continue;
    }

    // Detect new file
    if (line.startsWith('new file mode')) {
      if (currentFile) currentFile.newFile = true;
      continue;
    }

    // Detect deleted file
    if (line.startsWith('deleted file mode')) {
      if (currentFile) currentFile.deletedFile = true;
      continue;
    }

    // Detect rename
    if (line.startsWith('rename from')) {
      if (currentFile) {
        currentFile.oldPath = line.slice(12);
      }
      continue;
    }
    if (line.startsWith('rename to')) {
      if (currentFile) {
        currentFile.newPath = line.slice(10);
        currentFile.filePath = line.slice(10);
      }
      continue;
    }

    // Count additions/deletions
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (currentFile) currentFile.additions = (currentFile.additions || 0) + 1;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      if (currentFile) currentFile.deletions = (currentFile.deletions || 0) + 1;
    }

    if (currentFile) {
      diffLines.push(line);
    }
  }

  // Finalize last file
  if (currentFile) {
    finalizeFile(currentFile as MrDiff, diffLines);
    files.push(currentFile as MrDiff);
  }

  return files;
}

function finalizeFile(file: MrDiff, lines: string[]): void {
  file.diff = lines.join('\n');
  file.additions = file.additions || 0;
  file.deletions = file.deletions || 0;
}

/**
 * Score file risk (higher = more important to review first)
 */
export function scoreFileRisk(filePath: string): number {
  let score = 1;

  // Core/security files get higher priority
  if (/\b(main|index|core|security|auth|crypt)\b/.test(filePath)) score += 5;
  if (/\b(ipc|handler|router|controller)\b/.test(filePath)) score += 3;
  if (/\b(test|spec)\b/.test(filePath)) score -= 2;
  if (/\b(types|interface)\b/.test(filePath)) score += 1;

  // Configuration changes
  if (/(config|settings|env)/.test(filePath)) score += 2;

  // Package changes
  if (filePath.includes('package.json')) score += 4;

  return score;
}

/**
 * Split diffs into chunks that fit within token budget
 */
export function chunkDiffs(diffs: MrDiff[], budget: number): DiffChunk[] {
  // Sort by risk score (high risk first)
  const sorted = [...diffs].sort((a, b) => scoreFileRisk(b.filePath) - scoreFileRisk(a.filePath));

  const chunks: DiffChunk[] = [];
  let currentChunk: MrDiff[] = [];
  let currentTokens = 0;

  for (const diff of sorted) {
    const diffTokens = estimateTokens(diff.diff);

    if (currentTokens + diffTokens > budget && currentChunk.length > 0) {
      // Finalize current chunk
      chunks.push({
        files: currentChunk,
        estimatedTokens: currentTokens,
        index: chunks.length,
        total: 0, // Will be set later
      });
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(diff);
    currentTokens += diffTokens;
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push({
      files: currentChunk,
      estimatedTokens: currentTokens,
      index: chunks.length,
      total: 0,
    });
  }

  // Set total count
  const total = chunks.length;
  for (const chunk of chunks) {
    chunk.total = total;
  }

  logger.info(`Split ${diffs.length} files into ${chunks.length} chunks (budget: ${budget} tokens)`);
  for (const chunk of chunks) {
    logger.debug(`  Chunk ${chunk.index + 1}/${chunk.total}: ${chunk.files.length} files, ~${chunk.estimatedTokens} tokens`);
  }

  return chunks;
}

/**
 * Create a TokenBudget tracker for a review session
 */
export function createBudgetTracker(total: number): TokenBudget {
  return {
    total,
    used: 0,
    remaining: total,
  };
}

/**
 * Record token usage
 */
export function recordUsage(budget: TokenBudget, used: number): void {
  budget.used += used;
  budget.remaining = budget.total - budget.used;
  logger.debug(`Token usage: ${budget.used}/${budget.total} (${budget.remaining} remaining)`);
}
