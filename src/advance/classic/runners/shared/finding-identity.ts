import type { ReviewFinding } from '../../provider/types.js';
import type { MaintainerFindingDecision } from './state-utils.js';

export interface FindingIdentityOptions {
  projectRootPath?: string;
  changedFiles?: string[];
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function getBasename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 将 CI 绝对路径、仓库相对路径和唯一文件名统一为仓库相对路径。 */
export function normalizeFindingFilePath(
  path: string,
  options: FindingIdentityOptions = {}
): string {
  const normalized = normalizeSlashes(path);
  const normalizedLower = normalized.toLowerCase();
  const changedFiles = [...(options.changedFiles ?? [])]
    .map(normalizeSlashes)
    .sort((left, right) => right.length - left.length);

  const suffixMatches = changedFiles.filter(file => {
    const fileLower = file.toLowerCase();
    return (
      normalizedLower === fileLower ||
      normalizedLower.endsWith(`/${fileLower}`) ||
      fileLower.endsWith(`/${normalizedLower}`)
    );
  });
  if (suffixMatches.length === 1) return suffixMatches[0];

  const basename = getBasename(normalized).toLowerCase();
  const basenameMatches = changedFiles.filter(file => getBasename(file).toLowerCase() === basename);
  if (basenameMatches.length === 1) return basenameMatches[0];

  const projectName = options.projectRootPath
    ? getBasename(normalizeSlashes(options.projectRootPath))
    : '';
  if (projectName) {
    const marker = `/${projectName.toLowerCase()}/`;
    const index = normalizedLower.lastIndexOf(marker);
    if (index >= 0) return normalized.slice(index + marker.length);
  }

  return normalized.replace(/^\/+/, '');
}

export function getFindingKey(finding: Pick<ReviewFinding, 'file' | 'line'>): string {
  return `${finding.file}:${finding.line}`;
}

/** 规范化 finding，并按稳定 file:line 去除同一报告中的重复条目。 */
export function normalizeAndDedupeFindings(
  findings: ReviewFinding[],
  options: FindingIdentityOptions = {}
): ReviewFinding[] {
  const result: ReviewFinding[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    const normalizedFinding = {
      ...finding,
      file: normalizeFindingFilePath(finding.file, options),
    };
    const key = getFindingKey(normalizedFinding);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalizedFinding);
  }
  return result;
}

function parseFindingKey(key: string): { file: string; line: number } | null {
  const match = key.match(/^(.*):(\d+)$/);
  if (!match) return null;
  return { file: match[1], line: Number(match[2]) };
}

function decisionRank(decision: MaintainerFindingDecision): number {
  if (decision.fixSucceeded || decision.alreadyFixed || decision.action === 'ignore') return 3;
  if (decision.action === 'ask') return 2;
  return 1;
}

function preferDecision(
  current: MaintainerFindingDecision | undefined,
  candidate: MaintainerFindingDecision
): MaintainerFindingDecision {
  if (!current) return candidate;
  const currentRank = decisionRank(current);
  const candidateRank = decisionRank(candidate);
  if (currentRank !== candidateRank) return candidateRank > currentRank ? candidate : current;
  return candidate.decidedAt > current.decidedAt ? candidate : current;
}

/** 合并当前 finding 的历史路径别名；未命中当前集合的旧状态保留但不参与执行。 */
export function reconcileFindingDecisionAliases(
  decisions: Record<string, MaintainerFindingDecision>,
  activeFindingKeys: string[],
  options: FindingIdentityOptions = {}
): number {
  const activeKeys = new Set(activeFindingKeys);
  let merged = 0;
  for (const [storedKey, decision] of Object.entries(decisions)) {
    const parsed = parseFindingKey(storedKey);
    if (!parsed) continue;
    const canonicalKey = `${normalizeFindingFilePath(parsed.file, options)}:${parsed.line}`;
    if (canonicalKey === storedKey || !activeKeys.has(canonicalKey)) continue;
    decisions[canonicalKey] = preferDecision(decisions[canonicalKey], decision);
    delete decisions[storedKey];
    merged += 1;
  }
  return merged;
}
