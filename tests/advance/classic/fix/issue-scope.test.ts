/**
 * issue-scope 分类器单元测试
 */

import { describe, it, expect } from 'vitest';
import { IssueScopeClassifier } from '../../../../src/advance/classic/fix/issue-scope.js';
import type { ReviewFinding } from '../../../../src/advance/classic/provider/types.js';

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'MEDIUM',
    file: 'src/a.ts',
    line: 10,
    message: '问题',
    suggestion: '建议',
    ...overrides,
  };
}

function makeContext(snippet = 'code'): import('../../../../src/advance/classic/fix/focused-context-builder.js').FocusedContext {
  return {
    imports: '',
    snippet,
    snippetStartLine: 1,
    snippetEndLine: 1,
    totalLines: 10,
    truncated: false,
    targetLine: 10,
  };
}

describe('IssueScopeClassifier', () => {
  it('缺少行号时判定为 needs-clarification', async () => {
    const classifier = new IssueScopeClassifier();
    const result = await classifier.classify(makeFinding({ line: 0 }), makeContext());
    expect(result.scope).toBe('needs-clarification');
  });

  it('添加 TODO 判定为 trivial', async () => {
    const classifier = new IssueScopeClassifier();
    const result = await classifier.classify(
      makeFinding({ message: '缺少 TODO', suggestion: '添加 TODO 注释标识占位' }),
      makeContext()
    );
    expect(result.scope).toBe('trivial');
  });

  it('缓存环境变量判定为 trivial', async () => {
    const classifier = new IssueScopeClassifier();
    const result = await classifier.classify(
      makeFinding({
        message: '每次读取 process.env',
        suggestion: '将环境变量检查结果缓存在模块作用域常量中',
      }),
      makeContext()
    );
    expect(result.scope).toBe('trivial');
  });

  it('添加可选字段判定为 trivial', async () => {
    const classifier = new IssueScopeClassifier();
    const result = await classifier.classify(
      makeFinding({ message: '缺少 error 字段', suggestion: '在接口中添加 error?: number' }),
      makeContext()
    );
    expect(result.scope).toBe('trivial');
  });

  it('类型定义变更判定为 cross-file', async () => {
    const classifier = new IssueScopeClassifier();
    const result = await classifier.classify(
      makeFinding({
        message: 'MemoryLlmCallParams 接口定义缺少 error 字段',
        suggestion: '在接口中添加可选 error 字段，多个调用点传入了 error',
        ruleId: 'TYPE-SAFETY',
      }),
      makeContext()
    );
    expect(result.scope).toBe('cross-file');
  });

  it('普通函数内重构判定为 local', async () => {
    const classifier = new IssueScopeClassifier();
    const result = await classifier.classify(
      makeFinding({
        message: 'tracker 调用顺序不清晰',
        suggestion: '重构逻辑，把 tracker 调用统一放在 try/catch 最终出口',
      }),
      makeContext()
    );
    expect(result.scope).toBe('local');
  });

  it('启用 LLM 二次确认时按 mock 返回', async () => {
    const complete = async () =>
      JSON.stringify({ scope: 'cross-file', reason: 'LLM 判断需要改多个调用点' });
    const llmClient = {
      complete,
      completeJson: complete,
    } as unknown as import('../../../../src/advance/llm/client.js').LlmClient;

    const classifier = new IssueScopeClassifier({ llmClient, enableLlmConfirm: true });
    const result = await classifier.classify(makeFinding({ message: 'some local refactor' }), makeContext());
    expect(result.scope).toBe('cross-file');
  });

  it('LLM 返回非法 JSON 时回退到 local', async () => {
    const complete = async () => '不是 JSON';
    const llmClient = {
      complete,
      completeJson: complete,
    } as unknown as import('../../../../src/advance/llm/client.js').LlmClient;

    const classifier = new IssueScopeClassifier({ llmClient, enableLlmConfirm: true });
    const result = await classifier.classify(
      makeFinding({ message: '需要判断修改范围的局部重构问题', suggestion: '请确认范围' }),
      makeContext()
    );
    expect(result.scope).toBe('local');
  });
});
