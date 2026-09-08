/**
 * ast-grep 预检（M7 以 stage 形态回归）。
 *
 * 作为管线 stage 节点的执行体：对给定文件列表运行 ast-grep 规则扫描，
 * 产出结构化预检发现（advisory，供评审/记忆参考，不阻断）。
 * ast-grep 二进制缺失时优雅降级（skipped）。
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { logger } from '../core/logger.js';

export interface AstGrepPrecheckFinding {
  file: string;
  line: number;
  column: number;
  ruleId: string;
  message: string;
  severity: string;
}

export interface AstGrepPrecheckResult {
  skipped: boolean;
  reason?: string;
  findings: AstGrepPrecheckFinding[];
}

const SCAN_TIMEOUT_MS = 30_000;

/**
 * 对文件列表执行 ast-grep 扫描。
 * configPath：sgconfig.yml 路径；filePaths：待扫描文件（不存在的自动过滤）。
 */
export async function runAstGrepPrecheck(
  configPath: string,
  filePaths: string[]
): Promise<AstGrepPrecheckResult> {
  const existing = filePaths.filter(file => existsSync(file));
  if (existing.length === 0) {
    return { skipped: true, reason: '没有可扫描的文件', findings: [] };
  }
  if (!existsSync(configPath)) {
    return { skipped: true, reason: `ast-grep 配置不存在: ${configPath}`, findings: [] };
  }

  return new Promise(resolve => {
    // 数组参数不经 shell，避免路径注入。
    // 注意：Windows 上无 shell 的 spawn 解析不到 ast-grep.cmd shim，会走优雅降级（skipped）。
    const child = spawn('ast-grep', ['scan', '--config', configPath, '--json', ...existing], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ skipped: true, reason: 'ast-grep 扫描超时', findings: [] });
    }, SCAN_TIMEOUT_MS);

    child.stdout.on('data', chunk => (stdout += String(chunk)));
    child.stderr.on('data', chunk => (stderr += String(chunk)));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ skipped: true, reason: 'ast-grep 不可用（未安装）', findings: [] });
    });
    child.on('exit', () => {
      // ast-grep 有发现时返回非零退出码，stdout 仍是合法 JSON
      clearTimeout(timer);
      const findings = parseAstGrepOutput(stdout);
      if (findings.length === 0 && stderr.trim()) {
        logger.warn({ stderr: stderr.slice(-200) }, '[AstGrep] 扫描异常输出');
      }
      resolve({ skipped: false, findings });
    });
  });
}

/** 解析 ast-grep JSON 输出（兼容数组与 {results} 包装） */
export function parseAstGrepOutput(output: string): AstGrepPrecheckFinding[] {
  try {
    const parsed: unknown = JSON.parse(output);
    const entries = Array.isArray(parsed)
      ? parsed
      : ((parsed as { results?: unknown[] }).results ?? []);
    return (Array.isArray(entries) ? entries : []).flatMap((entry: Record<string, unknown>) => {
      const file = String(entry.file ?? '');
      const rules = Array.isArray(entry.rules) ? entry.rules : [entry];
      return (rules as Array<Record<string, unknown>>).map(rule => ({
        file,
        line: Number(rule.line ?? 0),
        column: Number(rule.column ?? 0),
        ruleId: String(rule.id ?? rule.ruleId ?? 'unknown'),
        message: String(rule.message ?? rule.text ?? ''),
        severity: String(rule.severity ?? rule.level ?? 'warning'),
      }));
    });
  } catch {
    return [];
  }
}
