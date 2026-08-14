const DEFAULT_ITEM_LIMIT = 6;
const DEFAULT_TOTAL_CHARS = 8000;

/** 解析 Provider 的 JSON 输出，兼容 Markdown 代码块包装。 */
export function parseProviderJson(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
}

/** 将常见查询结果 JSON 投影为适合提示词消费的短文本。 */
export function formatProviderJsonItems(
  value: unknown,
  limit = DEFAULT_ITEM_LIMIT,
  maxChars = DEFAULT_TOTAL_CHARS
): string[] {
  const candidates = findCandidateItems(value);
  const items = candidates.map(formatCandidate).filter(Boolean);
  if (items.length === 0 && value && typeof value === 'object') {
    items.push(formatCandidate(value));
  }
  return capKnowledgeItems(items, limit, maxChars);
}

/** 对知识条目去空、去重并施加总字符上限。 */
export function capKnowledgeItems(
  values: readonly string[],
  limit = DEFAULT_ITEM_LIMIT,
  maxChars = DEFAULT_TOTAL_CHARS
): string[] {
  const normalizedLimit = normalizePositiveInteger(limit, DEFAULT_ITEM_LIMIT);
  let remaining = normalizePositiveInteger(maxChars, DEFAULT_TOTAL_CHARS);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value) || remaining <= 0 || result.length >= normalizedLimit) continue;
    seen.add(value);
    const limited = value.slice(0, remaining);
    result.push(limited);
    remaining -= limited.length;
  }
  return result;
}

/** 将自然语言查询拆为适合代码标识符和中文文本匹配的词元。 */
export function tokenizeKnowledgeQuery(query: string): string[] {
  const tokens = new Set<string>();
  const matches = query.toLowerCase().match(/[\p{Script=Han}]{2,}|[\p{L}\p{N}_./:-]{2,}/gu) ?? [];
  for (const match of matches) {
    tokens.add(match);
    if (/^[\p{Script=Han}]+$/u.test(match) && match.length > 2) {
      for (let index = 0; index < match.length - 1; index += 1) {
        tokens.add(match.slice(index, index + 2));
      }
    }
  }
  return [...tokens].slice(0, 32);
}

/** 计算文本与查询词元的简单相关度。 */
export function scoreKnowledgeText(text: string, tokens: readonly string[]): number {
  const normalized = text.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (normalized === token) score += 12;
    else if (normalized.includes(token)) score += Math.max(2, Math.min(8, token.length));
  }
  return score;
}

function findCandidateItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value === null ? [] : [value];
  const record = value as Record<string, unknown>;
  for (const key of ['results', 'items', 'hits', 'nodes', 'projects', 'matches', 'data']) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [value];
}

function formatCandidate(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const preferredKeys = [
    'name',
    'qualified_name',
    'title',
    'label',
    'kind',
    'type',
    'signature',
    'path',
    'file',
    'file_path',
    'source_file',
    'source_location',
    'summary',
    'description',
    'snippet',
    'content',
    'score',
    'reason',
  ];
  const parts: string[] = [];
  for (const key of preferredKeys) {
    const formatted = formatScalar(record[key]);
    if (formatted) parts.push(`${key}: ${formatted}`);
  }
  if (parts.length > 0) return parts.join('；');

  for (const [key, item] of Object.entries(record).slice(0, 8)) {
    const formatted = formatScalar(item);
    if (formatted) parts.push(`${key}: ${formatted}`);
  }
  return parts.join('；');
}

function formatScalar(value: unknown): string {
  if (typeof value === 'string') return value.trim().slice(0, 1600);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(formatScalar).filter(Boolean).slice(0, 8).join(', ');
  }
  return '';
}

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
