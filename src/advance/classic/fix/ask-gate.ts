/**
 * ask 门禁（L2，见 docs/goals/maintainer-llm-centric-goal.md）
 *
 * 向 Reviewer 提问前，框架先校验「这个问题能否用 worktree 工具自答」。
 * 仓库内文件内容/代码片段属于可自查信息，禁止索问——这类问题一旦被提出，
 * 暴露的是框架失职而非信息缺失（真实现场实证："请提供 tracker.ts 文件的内容"）。
 *
 * 命中以下模式的提问应被门禁拦截并转为修复自查，而不是出现在 MR 上。
 */

const SELF_ANSWERABLE_PATTERNS: RegExp[] = [
  // 请提供/请贴出 xx 文件（的内容/代码/实现/片段）——间距放宽以容纳长文件路径
  /请(?:提供|贴出|贴下|发一下|发送)[\s\S]{0,120}(?:文件|内容|代码|实现|片段)/,
  // 能否/可以/能不能 提供/贴/发 xx 文件/代码/内容/实现
  /(?:能否|可以|能不能|烦请|麻烦)[\s\S]{0,15}(?:提供|贴|发)[\s\S]{0,30}(?:文件|代码|内容|片段|实现)/,
  // 把 xx 文件/代码 发/贴/提供 给我
  /把[\s\S]{0,15}(?:文件|代码|内容)[\s\S]{0,10}(?:发|贴|提供)/,
  // xx 文件的（完整|当前）内容/代码 是什么
  /(?:文件|代码)的(?:完整|当前|全部)?(?:内容|实现|代码)是(?:什么|啥)/,
  // 英文等价形态
  /please (?:provide|share|paste|show)[\s\S]{0,40}(?:file|code|content|snippet)/i,
  /(?:could|can) you (?:provide|share|paste|show)[\s\S]{0,40}(?:file|code|content|snippet)/i,
];

/**
 * 判断提问是否属于「仓库内可自查」的索问。
 *
 * 只拦截明确的文件内容/代码片段索问；意图澄清、方案取舍、业务上下文
 * 等真正需要人来回答的问题不在此列（保守放行）。
 */
export function isSelfAnswerableQuestion(question: string): boolean {
  const normalized = question.trim();
  if (!normalized) return false;
  return SELF_ANSWERABLE_PATTERNS.some(pattern => pattern.test(normalized));
}

/**
 * 判断 Reviewer 的回复是否「本身就是仓库内可查信息」（代码块或文件路径引用）。
 *
 * 用途（G7）：交互提问收到人工回复后直接转修复，若回复内容其实躺在仓库里，
 * 说明这次提问疑似本可被门禁拦截——作为漏判候选回流 EverOS 供模式库扩充。
 * 保守判定：只认代码围栏与带扩展名的文件路径，纯文字方案讨论不算。
 */
export function isRepoContentReply(body: string): boolean {
  if (!body) return false;
  if (/```/.test(body)) return true;
  return /[\w@~.-]+(?:\/[\w@~.()-]+)+\.(?:ts|tsx|js|jsx|mts|cts|py|go|java|rs|vue|json|ya?ml|toml|md)(?::\d+)?\b/.test(
    body
  );
}
