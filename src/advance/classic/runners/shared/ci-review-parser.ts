import { basename } from 'node:path';
import type { ReviewFinding } from '../../provider/types.js';

export interface CiReviewConfirmationItem {
  ruleId?: string;
  file: string;
  message: string;
}

export interface StructuredCiReview {
  round?: number;
  commitSha?: string;
  findings: ReviewFinding[];
  confirmationItems: CiReviewConfirmationItem[];
}

export interface CiReviewParserOptions {
  projectRootPath?: string;
  changedFiles?: string[];
}

const CI_REVIEW_HEADER = /^##\s+.*CI Review\b/im;
const CONFIRMATION_PATTERNS = [
  /请.{0,8}确认/,
  /需要.{0,8}确认/,
  /确认.{0,12}(必要|合理|允许|预期)/,
  /(保护|受保护).{0,8}文件/,
  /(不应|禁止).{0,8}(修改|变更)/,
  /requires?.{0,12}confirmation/i,
  /confirm.{0,12}(necessary|expected|allowed)/i,
  /protected.{0,8}file/i,
];

export function isCiReviewBody(body: string): boolean {
  return CI_REVIEW_HEADER.test(body);
}

export function parseStructuredCiReview(
  body: string,
  options: CiReviewParserOptions = {}
): StructuredCiReview | null {
  if (!isCiReviewBody(body)) return null;

  const header = body.match(/CI Review\s*·\s*Round\s*(\d+)(?:\s*·\s*commit\s+([0-9a-f]{7,40}))?/i);
  const findings: ReviewFinding[] = [];
  const confirmationItems: CiReviewConfirmationItem[] = [];
  let section: 'none' | 'rules' | 'analysis' | 'advantages' = 'none';
  let severity: ReviewFinding['severity'] = 'MEDIUM';

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (/^###\s+规则扫描/.test(line)) {
      section = 'rules';
      continue;
    }
    if (/^###\s+AI\s*分析/i.test(line)) {
      section = 'analysis';
      continue;
    }
    if (/^####\s+优点/.test(line)) {
      section = 'advantages';
      continue;
    }
    if (section === 'rules' && line === '---') {
      section = 'none';
      continue;
    }
    if (section === 'analysis') {
      const headingSeverity = parseSeverityHeading(line);
      if (headingSeverity) {
        severity = headingSeverity;
        continue;
      }
    }
    if (!line.startsWith('- ')) continue;

    if (section === 'rules') {
      const parsed = parseRuleItem(line, options);
      if (!parsed) continue;
      if (isConfirmationItem(parsed.ruleId, parsed.message)) {
        confirmationItems.push({
          ruleId: parsed.ruleId,
          file: parsed.file,
          message: parsed.message,
        });
        continue;
      }
      findings.push(...toFindings(parsed, 'MEDIUM'));
      continue;
    }

    if (section === 'analysis') {
      const parsed = parseAnalysisItem(line, options);
      if (parsed) findings.push(...toFindings(parsed, severity));
    }
  }

  return {
    round: header?.[1] ? Number(header[1]) : undefined,
    commitSha: header?.[2]?.toLowerCase(),
    findings,
    confirmationItems,
  };
}

interface ParsedItem {
  ruleId?: string;
  file: string;
  lines: number[];
  message: string;
  suggestion: string;
}

function parseRuleItem(line: string, options: CiReviewParserOptions): ParsedItem | null {
  const ruleId = line.match(/^[-+]\s+\*\*([^*]+)\*\*/)?.[1]?.trim();
  const contentLine = ruleId ? line.replace(/^([-+]\s+)\*\*[^*]+\*\*\s*/, '$1') : line;
  return parseItem(contentLine, options, ruleId);
}

function parseAnalysisItem(line: string, options: CiReviewParserOptions): ParsedItem | null {
  return parseItem(line, options);
}

function parseItem(
  line: string,
  options: CiReviewParserOptions,
  ruleId?: string
): ParsedItem | null {
  const cleaned = stripMarkdown(line.replace(/^[-+]\s+/, ''));
  const location = extractLocation(cleaned, options);
  if (!location) return null;

  const remainder = cleaned
    .replace(location.raw, '')
    .replace(/^\s*[|—–-]\s*/, '')
    .trim();
  const parts = remainder
    .split('|')
    .map(part => part.trim())
    .filter(Boolean);
  const message =
    parts.length > 0 ? parts.slice(0, Math.max(1, parts.length - 1)).join(' | ') : remainder;
  const suggestion = parts.length > 1 ? parts[parts.length - 1] : '';

  return {
    ruleId,
    file: location.file,
    lines: location.lines,
    message: message || remainder || '未描述的问题',
    suggestion,
  };
}

function extractLocation(
  text: string,
  options: CiReviewParserOptions
): { raw: string; file: string; lines: number[] } | null {
  const match = text.match(/((?:[A-Za-z]:)?[\\/\w@+.,()\-]+\.[A-Za-z0-9]+)(?::(\d+(?:,\d+)*))?/);
  if (!match) return null;
  const file = normalizeCiFilePath(match[1], options);
  const lines = match[2]
    ? match[2]
        .split(',')
        .map(Number)
        .filter(line => Number.isInteger(line) && line > 0)
    : [1];
  return { raw: match[0], file, lines: lines.length > 0 ? lines : [1] };
}

function normalizeCiFilePath(path: string, options: CiReviewParserOptions): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const changedFiles = [...(options.changedFiles ?? [])].sort((a, b) => b.length - a.length);
  const changedFile = changedFiles.find(
    file => normalized === file || normalized.endsWith(`/${file}`)
  );
  if (changedFile) return changedFile;

  const projectName = options.projectRootPath
    ? basename(options.projectRootPath).replace(/\\/g, '/')
    : '';
  if (projectName) {
    const marker = `/${projectName}/`;
    const index = normalized.toLowerCase().lastIndexOf(marker.toLowerCase());
    if (index >= 0) return normalized.slice(index + marker.length);
  }
  return normalized.replace(/^\/+/, '');
}

function stripMarkdown(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

function parseSeverityHeading(line: string): ReviewFinding['severity'] | null {
  if (!/^####\s+/.test(line)) return null;
  if (/严重|critical/i.test(line)) return 'CRITICAL';
  if (/高风险|\bhigh\b/i.test(line)) return 'HIGH';
  if (/中风险|\bmedium\b/i.test(line)) return 'MEDIUM';
  if (/低风险|\blow\b/i.test(line)) return 'LOW';
  return null;
}

function isConfirmationItem(ruleId: string | undefined, message: string): boolean {
  const text = `${ruleId ?? ''} ${message}`;
  return CONFIRMATION_PATTERNS.some(pattern => pattern.test(text));
}

function toFindings(item: ParsedItem, severity: ReviewFinding['severity']): ReviewFinding[] {
  return item.lines.map(line => ({
    severity,
    file: item.file,
    line,
    ruleId: item.ruleId,
    message: item.message,
    suggestion: item.suggestion || '请根据规则扫描结果检查并修复问题',
    autoFixable: false,
  }));
}
