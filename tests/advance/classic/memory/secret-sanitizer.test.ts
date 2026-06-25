import { describe, it, expect } from 'vitest';
import { SecretSanitizer } from '../../../../src/advance/classic/memory/secret-sanitizer.js';

describe('SecretSanitizer', () => {
  it('清洗 GitHub token', () => {
    const sanitizer = new SecretSanitizer();
    const result = sanitizer.sanitize('token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(result).toBe('token: <REDACTED_GITHUB_TOKEN>');
  });

  it('清洗 OpenAI key', () => {
    const sanitizer = new SecretSanitizer();
    const key = 'sk-' + 'a'.repeat(48);
    const result = sanitizer.sanitize(`key=${key}`);
    expect(result).toBe('key=<REDACTED_OPENAI_KEY>');
  });

  it('普通文本保持不变', () => {
    const sanitizer = new SecretSanitizer();
    const text = 'const userName = "alice";';
    expect(sanitizer.sanitize(text)).toBe(text);
  });
});
