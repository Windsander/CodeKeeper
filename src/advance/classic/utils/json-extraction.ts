/**
 * 从可能包含解释性文字的文本中提取最外层 JSON 对象或数组。
 *
 * 处理策略：
 * 1. 优先匹配 ```json ... ``` 或 ``` ... ``` 代码块。
 * 2. 否则从第一个 { 或 [ 开始，按括号平衡找到对应结束位置。
 * 3. 都没找到时返回原字符串，让上层解析失败并走兜底。
 */
export function extractJsonText(text: string): string {
  const trimmed = text.trim();

  const codeBlockMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  const firstChar = trimmed[0];
  if (firstChar === '[') {
    const arrayRange = findBalancedRange(trimmed, '[', ']');
    if (arrayRange) {
      return trimmed.slice(arrayRange.start, arrayRange.end + 1).trim();
    }
  }

  if (firstChar === '{') {
    const objectRange = findBalancedRange(trimmed, '{', '}');
    if (objectRange) {
      return trimmed.slice(objectRange.start, objectRange.end + 1).trim();
    }
  }

  // 兜底：按旧逻辑再扫描一次
  const objectRange = findBalancedRange(trimmed, '{', '}');
  if (objectRange) {
    return trimmed.slice(objectRange.start, objectRange.end + 1).trim();
  }

  const arrayRange = findBalancedRange(trimmed, '[', ']');
  if (arrayRange) {
    return trimmed.slice(arrayRange.start, arrayRange.end + 1).trim();
  }

  return trimmed;
}

function findBalancedRange(text: string, openChar: string, closeChar: string): { start: number; end: number } | null {
  const start = text.indexOf(openChar);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === openChar) {
      depth++;
    } else if (char === closeChar) {
      depth--;
      if (depth === 0) {
        return { start, end: i };
      }
    }
  }

  return null;
}
