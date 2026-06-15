import { describe, it, expect } from 'vitest';
import { isIpcResponse, isIpcPushEvent } from '../../../src/advance/ipc/types';

describe('ipc types', () => {
  it('应识别响应消息', () => {
    expect(isIpcResponse({ id: '1', result: {} })).toBe(true);
    expect(isIpcResponse({ type: 'push', event: 'x', payload: {} })).toBe(false);
  });

  it('应识别推送消息', () => {
    expect(isIpcPushEvent({ type: 'push', event: 'x', payload: {} })).toBe(true);
    expect(isIpcPushEvent({ id: '1', result: {} })).toBe(false);
  });
});
