import fs from 'fs/promises';
import path from 'path';
import { logger } from '../core/logger.js';
import type { ProjectConfig, LearningPattern } from '../types.js';

export class AstGrepGenerator {
  constructor(private project: ProjectConfig) {}

  /**
   * Generate ast-grep rule skeleton from a pattern
   */
  async generateRule(category: string, pattern: LearningPattern): Promise<string | null> {
    if (!this.project.learning.createAstGrepRules) {
      logger.info(`[${this.project.id}] ast-grep rule generation disabled`);
      return null;
    }

    const ruleId = `auto-${category}-${Date.now()}`;
    const ruleContent = this.buildRuleContent(ruleId, category, pattern);

    if (!ruleContent) {
      logger.warn(`[${this.project.id}] Could not generate rule for category "${category}"`);
      return null;
    }

    // Save to project's rules directory
    const rulesDir = path.join(
      this.project.localPath,
      path.dirname(this.project.review.astGrepConfig),
      'auto'
    );

    try {
      await fs.mkdir(rulesDir, { recursive: true });
      const rulePath = path.join(rulesDir, `${category}.yml`);
      await fs.writeFile(rulePath, ruleContent, 'utf8');
      logger.info(`[${this.project.id}] Generated ast-grep rule: ${rulePath}`);
      return rulePath;
    } catch (err) {
      logger.error({ err }, `[${this.project.id}] Failed to save ast-grep rule`);
      return null;
    }
  }

  /**
   * Build rule YAML content based on category
   */
  private buildRuleContent(ruleId: string, category: string, pattern: LearningPattern): string | null {
    const templates: Record<string, () => string> = {
      naming: () => this.buildNamingRule(ruleId, pattern),
      security: () => this.buildSecurityRule(ruleId, pattern),
      type: () => this.buildTypeRule(ruleId, pattern),
      duplicate: () => this.buildDuplicateRule(ruleId, pattern),
      redundant: () => this.buildRedundantRule(ruleId, pattern),
    };

    const template = templates[category] || templates.redundant;
    return template ? template() : null;
  }

  private buildNamingRule(ruleId: string, pattern: LearningPattern): string {
    return `# Auto-generated: Naming convention rule
# Learned from ${pattern.count} reviewer comments
id: ${ruleId}
language: ts
message: Naming convention violation
severity: warning
rule:
  pattern: $NAME
  constraints:
    # Add specific naming patterns here
    # Example: function names should be camelCase
    # regex: '^[a-z][a-zA-Z0-9]*$'
  fix: ~
  # Example fix:
  # fix: $NAME → corrected_name

# Reviewer comments that triggered this rule:
${pattern.examples.map((e) => `# - ${e.slice(0, 100)}`).join('\n')}
`;
  }

  private buildSecurityRule(ruleId: string, pattern: LearningPattern): string {
    return `# Auto-generated: Security rule
# Learned from ${pattern.count} reviewer comments
id: ${ruleId}
language: ts
message: Potential security issue
severity: error
rule:
  pattern: |
    process.env.$ENV
  constraints:
    # Customize for specific security patterns
    # Example: unguarded env variable usage
    # inside:
    #   not:
    #     pattern: if ($GUARD) { $$$ }

# Reviewer comments that triggered this rule:
${pattern.examples.map((e) => `# - ${e.slice(0, 100)}`).join('\n')}
`;
  }

  private buildTypeRule(ruleId: string, pattern: LearningPattern): string {
    return `# Auto-generated: Type safety rule
# Learned from ${pattern.count} reviewer comments
id: ${ruleId}
language: ts
message: Type safety issue
severity: warning
rule:
  pattern: |
    $VAR as any
  fix: |
    $VAR as unknown

# Reviewer comments that triggered this rule:
${pattern.examples.map((e) => `# - ${e.slice(0, 100)}`).join('\n')}
`;
  }

  private buildDuplicateRule(ruleId: string, pattern: LearningPattern): string {
    return `# Auto-generated: Duplicate detection rule
# Learned from ${pattern.count} reviewer comments
id: ${ruleId}
language: ts
message: Potential code duplication
severity: info
rule:
  # This is a placeholder - duplicate detection usually requires
  # more sophisticated analysis. Consider using copy-paste detection tools.
  pattern: |
    $FUNC
  constraints:
    # Add specific duplication patterns

# Reviewer comments that triggered this rule:
${pattern.examples.map((e) => `# - ${e.slice(0, 100)}`).join('\n')}
`;
  }

  private buildRedundantRule(ruleId: string, pattern: LearningPattern): string {
    return `# Auto-generated: Redundancy rule
# Learned from ${pattern.count} reviewer comments
id: ${ruleId}
language: ts
message: Redundant or unnecessary code
severity: info
rule:
  pattern: |
    $UNUSED
  constraints:
    # Customize for specific redundancy patterns
    # Example: unused imports
    # kind: import_statement
    # not:
    #   has:
    #     pattern: $UNUSED

# Reviewer comments that triggered this rule:
${pattern.examples.map((e) => `# - ${e.slice(0, 100)}`).join('\n')}
`;
  }
}
