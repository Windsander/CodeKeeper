/**
 * Setup 命令安全过滤器
 *
 * 只允许安装/构建类命令，禁止 shell 控制字符、破坏性命令和路径逃逸。
 */
export class SetupCommandSafetyFilter {
  private readonly dangerousPatterns = [
    /;/, /&&/, /\|/, />/, /</, /\$\(/, /`/, /\*\*/,
    /\b(rm|sudo|chmod|mkfs|dd|eval|source)\b/i,
    /curl\s*\|/i, /wget\s*\|/i,
    /\.\./, /~/, /\/etc/, /\/usr/, /\/bin/,
  ];

  private readonly allowedPrefixes = [
    'npm', 'yarn', 'pnpm', 'cargo', 'pip', 'poetry', 'go',
  ];

  check(command: string): { allowed: boolean; reason?: string } {
    const normalized = command.trim().replace(/\s+/g, ' ');
    if (!normalized) {
      return { allowed: false, reason: '命令不能为空' };
    }

    for (const pattern of this.dangerousPatterns) {
      if (pattern.test(normalized)) {
        return { allowed: false, reason: `命令包含危险模式: ${pattern}` };
      }
    }

    const first = normalized.split(' ')[0].toLowerCase();
    if (!this.allowedPrefixes.includes(first)) {
      return { allowed: false, reason: `不允许的命令前缀: ${first}` };
    }

    return { allowed: true };
  }
}
