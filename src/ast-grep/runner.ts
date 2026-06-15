import { execSync } from 'child_process';
import { logger } from '../core/logger.js';
import type { AstGrepFinding } from '../types.js';

/**
 * Run ast-grep scan on given files
 */
export function runAstGrep(configPath: string, filePaths: string[]): AstGrepFinding[] {
  if (filePaths.length === 0) {
    return [];
  }

  // Filter to only existing files
  const fs = require('fs');
  const existingFiles = filePaths.filter((f) => fs.existsSync(f));

  if (existingFiles.length === 0) {
    return [];
  }

  try {
    const result = execSync(
      `ast-grep scan --config "${configPath}" --json ${existingFiles.map((f) => `"${f}"`).join(' ')}`,
      {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      }
    );

    return parseAstGrepOutput(result);
  } catch (err) {
    // ast-grep returns non-zero when findings exist
    const errorOutput = (err as Error & { stdout?: string; stderr?: string }).stdout;
    if (errorOutput) {
      return parseAstGrepOutput(errorOutput);
    }
    logger.warn({ err: (err as Error).message }, 'ast-grep scan failed');
    return [];
  }
}

/**
 * Parse ast-grep JSON output
 */
function parseAstGrepOutput(output: string): AstGrepFinding[] {
  try {
    const parsed = JSON.parse(output);

    if (Array.isArray(parsed)) {
      return parsed.flatMap((entry: Record<string, unknown>) => {
        const file = String(entry.file || '');
        const rules = entry.rules || [];
        return (Array.isArray(rules) ? rules : []).map((rule: Record<string, unknown>) => ({
          file,
          line: Number(rule.line || 0),
          column: Number(rule.column || 0),
          ruleId: String(rule.id || rule.ruleId || 'unknown'),
          message: String(rule.message || rule.text || ''),
          severity: String(rule.severity || rule.level || 'warning'),
        }));
      });
    }

    // Alternative format: object keyed by file
    const findings: AstGrepFinding[] = [];
    for (const [file, rules] of Object.entries(parsed)) {
      if (Array.isArray(rules)) {
        for (const rule of rules) {
          findings.push({
            file,
            line: Number(rule.line || 0),
            column: Number(rule.column || 0),
            ruleId: String(rule.id || rule.ruleId || 'unknown'),
            message: String(rule.message || rule.text || ''),
            severity: String(rule.severity || rule.level || 'warning'),
          });
        }
      }
    }
    return findings;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Failed to parse ast-grep output');
    return [];
  }
}
