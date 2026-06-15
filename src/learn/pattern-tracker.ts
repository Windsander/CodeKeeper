import fs from 'fs/promises';
import path from 'path';
import { logger } from '../core/logger.js';
import { getConfigDir } from '../core/platform.js';
import type { ProjectConfig, LearningPattern } from '../types.js';

const PATTERN_DB_DIR = path.join(getConfigDir(), 'patterns');

// Comment categorization keywords
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  naming: ['rename', 'naming', 'name should', '命名', '变量名', '函数名'],
  security: ['security', 'unsafe', 'vulnerable', 'inject', 'xss', '泄露', '安全', '密钥'],
  type: ['type', 'typescript', 'any', 'unknown', '类型', '类型断言'],
  duplicate: ['duplicate', '重复', '重复导出', '重复注册'],
  redundant: ['redundant', 'unused', 'unnecessary', '冗余', '多余', '未使用'],
  performance: ['performance', 'slow', 'optimize', '性能', '优化'],
  testing: ['test', 'spec', 'coverage', '测试', '用例'],
  documentation: ['doc', 'comment', '文档', '注释'],
  architecture: ['architecture', 'layer', '依赖', '架构', '分层'],
};

export class PatternTracker {
  private dbPath: string;

  constructor(private project: ProjectConfig) {
    this.dbPath = path.join(PATTERN_DB_DIR, `${project.id}.json`);
  }

  /**
   * Ensure pattern DB directory exists
   */
  private async ensureDir(): Promise<void> {
    await fs.mkdir(PATTERN_DB_DIR, { recursive: true });
  }

  /**
   * Load existing patterns
   */
  private async loadPatterns(): Promise<LearningPattern[]> {
    await this.ensureDir();
    try {
      const data = await fs.readFile(this.dbPath, 'utf8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  /**
   * Save patterns
   */
  private async savePatterns(patterns: LearningPattern[]): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(this.dbPath, JSON.stringify(patterns, null, 2));
  }

  /**
   * Categorize a review comment
   */
  categorizeComment(comment: string): string {
    const lower = comment.toLowerCase();

    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      if (keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
        return category;
      }
    }

    return 'general';
  }

  /**
   * Process new comments and update pattern counts
   * Returns categories that have reached the threshold
   */
  async processComments(
    comments: Array<{ author: string; body: string; createdAt: string }>
  ): Promise<string[]> {
    const patterns = await this.loadPatterns();
    const triggered: string[] = [];

    for (const comment of comments) {
      const category = this.categorizeComment(comment.body);

      let pattern = patterns.find((p) => p.category === category);
      if (!pattern) {
        pattern = {
          category,
          count: 0,
          examples: [],
          lastSeen: comment.createdAt,
        };
        patterns.push(pattern);
      }

      pattern.count++;
      pattern.lastSeen = comment.createdAt;

      // Keep last 5 examples
      if (!pattern.examples.includes(comment.body)) {
        pattern.examples.push(comment.body);
        if (pattern.examples.length > 5) {
          pattern.examples.shift();
        }
      }

      logger.info(
        `[${this.project.id}] Pattern "${category}": count=${pattern.count}`
      );

      if (pattern.count >= this.project.learning.patternThreshold) {
        triggered.push(category);
      }
    }

    await this.savePatterns(patterns);
    return [...new Set(triggered)];
  }

  /**
   * Get all patterns for a project
   */
  async getPatterns(): Promise<LearningPattern[]> {
    return this.loadPatterns();
  }

  /**
   * Reset pattern count for a category (after rule is created)
   */
  async resetPattern(category: string): Promise<void> {
    const patterns = await this.loadPatterns();
    const pattern = patterns.find((p) => p.category === category);
    if (pattern) {
      pattern.count = 0;
      pattern.examples = [];
      await this.savePatterns(patterns);
    }
  }
}
