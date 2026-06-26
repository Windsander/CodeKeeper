const ANTHROPIC_MAP: Record<string, string> = {
  'claude-opus-4-8': 'Opus-4.8',
  'claude-opus-4-7': 'Opus-4.7',
  'claude-opus-4-6': 'Opus-4.6',
  'claude-opus-4-5': 'Opus-4.5',
  'claude-sonnet-4-8': 'Sonnet-4.8',
  'claude-sonnet-4-7': 'Sonnet-4.7',
  'claude-sonnet-4-6': 'Sonnet-4.6',
  'claude-sonnet-4-5': 'Sonnet-4.5',
  'claude-haiku-4-5': 'Haiku-4.5',
};

/**
 * 将模型全名转换为短标签，用于服务状态面板显示。
 * 例如 claude-opus-4-8 → Opus-4.8，gpt-4o → GPT-4O。
 */
export function formatModelShortName(model: string): string {
  if (!model) return '未配置';
  const normalized = model.trim().toLowerCase();
  if (ANTHROPIC_MAP[normalized]) return ANTHROPIC_MAP[normalized];
  if (normalized.startsWith('gpt-')) {
    return model.trim().toUpperCase();
  }
  const withoutPrefix = normalized.replace(/^(claude|openai|anthropic|google)-/, '');
  const short = withoutPrefix
    .split('-')
    .map((part, idx) => (idx === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join('-');
  return short.length > 20 ? `${short.slice(0, 20)}...` : short;
}
