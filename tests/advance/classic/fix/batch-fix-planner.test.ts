/**
 * BatchFixPlanner 单元测试
 */

import { describe, it, expect } from 'vitest';
import { BatchFixPlanner } from '../../../../src/advance/classic/fix/batch-fix-planner.js';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import type { ReviewFinding } from '../../../../src/advance/classic/provider/types.js';

function createMockLlmClient(response: string): LlmClient {
  return new LlmClient({
    apiKey: 'test',
    mock: { response },
  });
}

const mockFinding: ReviewFinding = {
  severity: 'MEDIUM',
  file: 'src/a.ts',
  line: 2,
  message: '变量未使用',
  suggestion: '删除 unused 变量',
  autoFixable: true,
};

describe('BatchFixPlanner', () => {
  it('从 LLM JSON 中解析批量修复计划', async () => {
    const planner = new BatchFixPlanner({
      llmClient: createMockLlmClient(
        JSON.stringify({
          reason: '删除未使用变量',
          patches: [
            {
              filePath: 'src/a.ts',
              patch: `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,2 @@
 const used = 1;
-const unused = 2;
 console.log(used);
`,
            },
          ],
        })
      ),
    });

    const plan = await planner.plan({
      findings: [mockFinding],
      fileContents: { 'src/a.ts': 'const used = 1;\nconst unused = 2;\nconsole.log(used);\n' },
      originalComment: '这里有个未使用变量',
    });

    expect(plan.reason).toBe('删除未使用变量');
    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0].filePath).toBe('src/a.ts');
    expect(plan.patches[0].patch).toContain('diff --git');
  });

  it('过滤掉无效 patch 项', async () => {
    const planner = new BatchFixPlanner({
      llmClient: createMockLlmClient(
        JSON.stringify({
          reason: '部分修复',
          patches: [
            { filePath: 'src/a.ts', patch: 'valid patch' },
            { filePath: '', patch: 'no path' },
            { filePath: 'src/b.ts', patch: '' },
          ],
        })
      ),
    });

    const plan = await planner.plan({
      findings: [mockFinding],
      fileContents: { 'src/a.ts': 'a\n' },
      originalComment: 'comment',
    });

    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0].filePath).toBe('src/a.ts');
  });

  it('LLM 返回非法 JSON 时返回空计划', async () => {
    const planner = new BatchFixPlanner({
      llmClient: createMockLlmClient('不是 JSON'),
    });

    const plan = await planner.plan({
      findings: [mockFinding],
      fileContents: { 'src/a.ts': 'a\n' },
      originalComment: 'comment',
    });

    expect(plan.patches).toHaveLength(0);
    expect(plan.reason).toContain('未返回有效计划');
  });
});
