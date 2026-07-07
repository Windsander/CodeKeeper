/**
 * cross-file-planner 单元测试
 */

import { describe, it, expect } from 'vitest';
import { CrossFilePlanner } from '../../../../src/advance/classic/fix/cross-file-planner.js';
import type { ReviewFinding } from '../../../../src/advance/classic/provider/types.js';
import type { LlmClient } from '../../../../src/advance/llm/client.js';

function makeFinding(): ReviewFinding {
  return {
    severity: 'HIGH',
    file: 'packages/a/src/types.ts',
    line: 10,
    message: '接口缺少 error 字段',
    suggestion: '添加 error?: number 并同步调用点',
  };
}

function makeContext(): import('../../../../src/advance/classic/fix/focused-context-builder.js').FocusedContext {
  return {
    imports: "import { X } from 'x';",
    snippet: 'export interface Foo {}',
    snippetStartLine: 1,
    snippetEndLine: 1,
    totalLines: 10,
    truncated: false,
    targetLine: 10,
  };
}

describe('CrossFilePlanner', () => {
  it('解析 LLM 返回的跨文件计划', async () => {
    const llmClient = {
      complete: async () =>
        JSON.stringify({
          reason: '类型变更影响调用点',
          patches: [
            { filePath: 'packages/a/src/types.ts', description: '添加 error 字段' },
            { filePath: 'packages/a/src/use.ts', description: '传入 error 参数' },
          ],
        }),
    } as unknown as LlmClient;

    const planner = new CrossFilePlanner({ llmClient });
    const plan = await planner.plan(makeFinding(), makeContext());

    expect(plan.reason).toBe('类型变更影响调用点');
    expect(plan.patches).toHaveLength(2);
    expect(plan.patches[0].filePath).toBe('packages/a/src/types.ts');
    expect(plan.patches[1].filePath).toBe('packages/a/src/use.ts');
  });

  it('空 patches 时回退到主文件', async () => {
    const llmClient = {
      complete: async () => JSON.stringify({ reason: '不需要跨文件', patches: [] }),
    } as unknown as LlmClient;

    const planner = new CrossFilePlanner({ llmClient });
    const plan = await planner.plan(makeFinding(), makeContext());

    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0].filePath).toBe('packages/a/src/types.ts');
  });

  it('非法 JSON 时回退到主文件', async () => {
    const llmClient = {
      complete: async () => '不是 JSON',
    } as unknown as LlmClient;

    const planner = new CrossFilePlanner({ llmClient });
    const plan = await planner.plan(makeFinding(), makeContext());

    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0].filePath).toBe('packages/a/src/types.ts');
  });
});
