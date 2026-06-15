import fs from 'fs/promises';
import path from 'path';
import { logger } from '../core/logger.js';
import type { ProjectConfig, LearningPattern } from '../types.js';

export class ClaudeMdUpdater {
  constructor(private project: ProjectConfig) {}

  /**
   * Append a learned rule to CLAUDE.md
   */
  async appendRule(category: string, pattern: LearningPattern): Promise<boolean> {
    if (!this.project.learning.updateClaudeMd) {
      logger.info(`[${this.project.id}] CLAUDE.md update disabled`);
      return false;
    }

    const claudeMdPath = path.join(this.project.localPath, this.project.review.rulesFile);

    try {
      let content = '';
      try {
        content = await fs.readFile(claudeMdPath, 'utf8');
      } catch {
        // File doesn't exist, create it
        logger.info(`[${this.project.id}] Creating ${this.project.review.rulesFile}`);
        content = '# Review Rules\n\n';
      }

      const ruleSection = this.generateRuleSection(category, pattern);

      // Check if this rule already exists
      if (content.includes(ruleSection.trim())) {
        logger.info(`[${this.project.id}] Rule for "${category}" already exists, skipping`);
        return false;
      }

      // Append to file
      const updated = content.trimEnd() + '\n\n' + ruleSection + '\n';
      await fs.writeFile(claudeMdPath, updated, 'utf8');

      logger.info(`[${this.project.id}] Appended rule for "${category}" to ${this.project.review.rulesFile}`);
      return true;
    } catch (err) {
      logger.error({ err }, `[${this.project.id}] Failed to update CLAUDE.md`);
      return false;
    }
  }

  /**
   * Generate a rule section from pattern examples
   */
  private generateRuleSection(category: string, pattern: LearningPattern): string {
    const descriptions: Record<string, string> = {
      naming: '### Naming Conventions\n\nUse clear and consistent naming. Follow existing patterns in the codebase.',
      security: '### Security\n\nAlways validate user input. Never expose secrets in code.',
      type: '### Type Safety\n\nAvoid `any`. Use `unknown` or specific types. Prefer strict typing.',
      duplicate: '### Code Reuse\n\nAvoid duplication. Extract shared logic into reusable functions.',
      redundant: '### Clean Code\n\nRemove unused code and imports. Keep files focused.',
      performance: '### Performance\n\nAvoid unnecessary allocations. Prefer efficient algorithms.',
      testing: '### Testing\n\nWrite tests for new features. Maintain test coverage.',
      documentation: '### Documentation\n\nAdd comments for non-obvious logic. Keep docs up to date.',
      architecture: '### Architecture\n\nFollow layer boundaries. Avoid circular dependencies.',
      general: '### General Guidelines\n\nFollow team conventions and best practices.',
    };

    const lines: string[] = [];
    lines.push(`## [Auto] ${this.capitalize(category)} Rules`);
    lines.push('');
    lines.push(`> Learned from ${pattern.count} reviewer comments`);
    lines.push('');
    lines.push(descriptions[category] || descriptions.general);
    lines.push('');

    if (pattern.examples.length > 0) {
      lines.push('**Examples from reviews:**');
      for (const example of pattern.examples) {
        const truncated = example.length > 200 ? example.slice(0, 200) + '...' : example;
        lines.push(`- ${truncated}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}
