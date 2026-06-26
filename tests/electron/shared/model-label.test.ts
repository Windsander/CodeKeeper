import { describe, it, expect } from 'vitest';
import { formatModelShortName } from '../../../src/electron/shared/model-label.js';

describe('formatModelShortName', () => {
  it('映射已知的 Claude 模型', () => {
    expect(formatModelShortName('claude-opus-4-8')).toBe('Opus-4.8');
    expect(formatModelShortName('claude-sonnet-4-6')).toBe('Sonnet-4.6');
  });

  it('GPT 模型大写', () => {
    expect(formatModelShortName('gpt-4o')).toBe('GPT-4O');
  });

  it('空字符串显示未配置', () => {
    expect(formatModelShortName('')).toBe('未配置');
  });

  it('未知模型截断显示', () => {
    expect(formatModelShortName('custom-very-long-model-name-2024')).toBe('Custom-very-long-mod...');
  });
});
