import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../core/logger.js';
import {
  buildReviewPrompt,
  buildFixPrompt,
  formatReviewComment,
} from './prompt-builder.js';
import {
  parseDiff,
  chunkDiffs,
  calculateDiffBudget,
  estimateTokens,
  createBudgetTracker,
  recordUsage,
} from '../core/token-budget.js';
import { ProjectSync } from '../core/project-sync.js';
import { MRService } from '../gitlab/mr-service.js';
import { runAstGrep } from '../ast-grep/runner.js';
import type {
  ProjectConfig,
  MergeRequest,
  ReviewResult,
  ReviewFinding,
} from '../types.js';

const ANTHROPIC_MODEL = 'claude-sonnet-4-6-20251001';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export class Reviewer {
  private anthropic: Anthropic;
  private projectSync: ProjectSync;
  private mrService: MRService;

  constructor(private project: ProjectConfig) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }
    this.anthropic = new Anthropic({ apiKey });
    this.projectSync = new ProjectSync(project);
    this.mrService = new MRService(project);
  }

  /**
   * Review a single MR
   */
  async reviewMR(mr: MergeRequest): Promise<ReviewResult> {
    logger.info(`[${this.project.id}] Starting review of MR !${mr.iid}: ${mr.title}`);

    // 1. Sync project
    await this.projectSync.sync();

    // 2. Get diff
    const diffText = await this.projectSync.getDiff(mr.targetBranch, mr.sourceBranch);
    const diffs = parseDiff(diffText);

    if (diffs.length === 0) {
      logger.info(`[${this.project.id}] MR !${mr.iid} has no changes, skipping`);
      return { findings: [], summary: 'No changes to review', autoFixable: [] };
    }

    // 3. Load rules
    const claudeMdRules = await this.projectSync.loadClaudeMd();

    // 4. Run ast-grep pre-check
    const astGrepFindings = await this.runAstGrepPreCheck(diffs);

    // 5. Calculate budget and chunk
    const diffBudget = calculateDiffBudget(this.project.review.tokenBudget);
    const chunks = chunkDiffs(diffs, diffBudget);
    const budget = createBudgetTracker(this.project.review.tokenBudget);

    // 6. Review each chunk
    const allFindings: ReviewFinding[] = [];
    const allAutoFixable: number[] = [];
    let chunkOffset = 0;

    for (const chunk of chunks) {
      const prompt = buildReviewPrompt(
        claudeMdRules,
        chunk,
        astGrepFindings.filter((f) =>
          chunk.files.some((file) => file.filePath === f.file || file.newPath === f.file)
        ),
        mr.title,
        mr.description
      );

      const promptTokens = estimateTokens(prompt);
      logger.info(
        `[${this.project.id}] MR !${mr.iid} chunk ${chunk.index + 1}/${chunk.total}: ` +
          `~${promptTokens} prompt tokens, ${chunk.files.length} files`
      );

      const chunkResult = await this.callAI(prompt, budget);

      // Adjust indices for multi-chunk
      for (const idx of chunkResult.autoFixable) {
        allAutoFixable.push(chunkOffset + idx);
      }
      allFindings.push(...chunkResult.findings);
      chunkOffset += chunkResult.findings.length;

      recordUsage(budget, promptTokens + estimateTokens(chunkResult.rawResponse || ''));
    }

    const result: ReviewResult = {
      findings: allFindings,
      summary: `Found ${allFindings.length} issue(s) across ${chunks.length} chunk(s)`,
      autoFixable: allAutoFixable,
    };

    // 7. Post review comment
    if (allFindings.length > 0 || chunks.length > 1) {
      const comment = formatReviewComment({
        findings: allFindings,
        summary: result.summary,
      });
      await this.mrService.postReviewComment(mr.iid, comment);
    } else {
      logger.info(`[${this.project.id}] MR !${mr.iid}: no issues, no comment posted`);
    }

    logger.info(
      `[${this.project.id}] Review complete for MR !${mr.iid}: ` +
        `${allFindings.length} findings, budget used: ${budget.used}/${budget.total}`
    );

    return result;
  }

  /**
   * Call Claude API with retry logic
   */
  private async callAI(prompt: string, budget: { remaining: number }): Promise<ReviewResult> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        logger.debug(`AI call attempt ${attempt}/${MAX_RETRIES}`);

        const response = await this.anthropic.messages.create({
          model: ANTHROPIC_MODEL,
          max_tokens: Math.min(16000, Math.floor(budget.remaining * 0.4)),
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
        });

        const content = response.content
          .map((c) => (c.type === 'text' ? c.text : ''))
          .join('');

        return this.parseReviewResponse(content);
      } catch (err) {
        lastError = err as Error;
        logger.warn({ err: lastError.message }, `AI call attempt ${attempt} failed`);

        if (attempt < MAX_RETRIES) {
          await this.delay(RETRY_DELAY_MS * attempt);
        }
      }
    }

    throw new Error(`AI review failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
  }

  /**
   * Parse AI response into structured ReviewResult
   */
  private parseReviewResponse(content: string): ReviewResult {
    // Try to extract JSON from response
    let jsonStr = content;

    // Look for JSON block
    const jsonBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (jsonBlockMatch) {
      jsonStr = jsonBlockMatch[1].trim();
    }

    // Try parsing
    try {
      const parsed = JSON.parse(jsonStr);

      const findings: ReviewFinding[] = (parsed.findings || []).map((f: unknown) => ({
        severity: this.normalizeSeverity((f as Record<string, unknown>).severity),
        file: String((f as Record<string, unknown>).file || ''),
        line: Number((f as Record<string, unknown>).line || 0),
        ruleId: (f as Record<string, unknown>).ruleId ? String((f as Record<string, unknown>).ruleId) : undefined,
        message: String((f as Record<string, unknown>).message || ''),
        suggestion: String((f as Record<string, unknown>).suggestion || ''),
      }));

      return {
        findings,
        summary: String(parsed.summary || ''),
        autoFixable: Array.isArray(parsed.autoFixable) ? parsed.autoFixable : [],
        rawResponse: content,
      };
    } catch (parseErr) {
      logger.warn({ err: (parseErr as Error).message, content: content.slice(0, 500) },
        'Failed to parse AI response as JSON, returning raw');

      // Fallback: return empty findings with raw response for debugging
      return {
        findings: [],
        summary: 'AI response could not be parsed (see logs)',
        autoFixable: [],
        rawResponse: content,
      };
    }
  }

  /**
   * Run ast-grep pre-check on changed files
   */
  private async runAstGrepPreCheck(diffs: import('../types.js').MrDiff[]): Promise<import('../types.js').AstGrepFinding[]> {
    const astGrepConfig = this.project.review.astGrepConfig;
    const configPath = `${this.project.localPath}/${astGrepConfig}`;

    const fs = await import('fs');
    if (!fs.existsSync(configPath)) {
      logger.debug(`[${this.project.id}] ast-grep config not found: ${configPath}`);
      return [];
    }

    const filePaths = diffs.map((d) => `${this.project.localPath}/${d.filePath}`);
    return runAstGrep(configPath, filePaths);
  }

  /**
   * Generate fix for a single finding
   */
  async generateFix(filePath: string, finding: ReviewFinding): Promise<string | null> {
    try {
      const content = await this.projectSync.readFile(filePath);
      const prompt = buildFixPrompt(filePath, content, finding);

      const response = await this.anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const fixedContent = response.content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('')
        .trim();

      // Clean up common wrapper artifacts
      return this.cleanFixOutput(fixedContent);
    } catch (err) {
      logger.error({ err, filePath }, 'Failed to generate fix');
      return null;
    }
  }

  private cleanFixOutput(content: string): string {
    // Remove markdown code block wrappers if present
    const codeBlockMatch = content.match(/```(?:\w+)?\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }
    return content;
  }

  private normalizeSeverity(sev: unknown): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
    const s = String(sev).toUpperCase();
    if (s === 'CRITICAL' || s === 'CRIT') return 'CRITICAL';
    if (s === 'HIGH') return 'HIGH';
    if (s === 'MEDIUM' || s === 'MED') return 'MEDIUM';
    if (s === 'LOW') return 'LOW';
    return 'MEDIUM'; // default
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
