import { describe, expect, it } from 'vitest';
import {
  isCiReviewBody,
  parseStructuredCiReview,
} from '../../../../../src/advance/classic/runners/shared/ci-review-parser.js';

describe('ci-review-parser', () => {
  it('结构化拆分规则确认项与 AI finding，并忽略优点列表', () => {
    const body = `## 🤖 CI Review · Round 8 · commit a1b2c3d4

### 规则扫描
<details>
<summary>展开规则结果</summary>

  - **任意保护策略名称** \`virtual-project/src/app/main.ts:1\` | 保护文件被修改，请确认必要性
</details>

### AI 分析

#### 🟢 低风险

  - \`virtual-project/packages/example-memory/src/core/foundation/telemetry/__tests__/tracker.test.ts:36\` | 删除的 no-op 测试覆盖了默认 sink 路径 | 可考虑补一条未注入时调用不抛异常的单行用例

#### 优点

- \`packages/example-memory/src/core/foundation/telemetry/tracker.ts:20\` | import 已同步清理，无残留
`;

    const result = parseStructuredCiReview(body, {
      projectRootPath: 'virtual-project',
      changedFiles: [
        'src/app/main.ts',
        'packages/example-memory/src/core/foundation/telemetry/__tests__/tracker.test.ts',
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.round).toBe(8);
    expect(result?.commitSha).toBe('a1b2c3d4');
    expect(result?.confirmationItems).toEqual([
      {
        ruleId: '任意保护策略名称',
        file: 'src/app/main.ts',
        message: '保护文件被修改，请确认必要性',
      },
    ]);
    expect(result?.findings).toEqual([
      expect.objectContaining({
        severity: 'LOW',
        file: 'packages/example-memory/src/core/foundation/telemetry/__tests__/tracker.test.ts',
        line: 36,
        message: '删除的 no-op 测试覆盖了默认 sink 路径',
        suggestion: '可考虑补一条未注入时调用不抛异常的单行用例',
      }),
    ]);
  });

  it('按确认语义识别英文规则，不依赖固定规则名', () => {
    const body = `## CI Review · Round 2 · commit deadbee

### 规则扫描
- **Architecture Boundary** src/bootstrap.ts:4 | Protected file changed; requires confirmation

### AI 分析
`;

    const result = parseStructuredCiReview(body);

    expect(result?.findings).toEqual([]);
    expect(result?.confirmationItems).toEqual([
      expect.objectContaining({
        ruleId: 'Architecture Boundary',
        file: 'src/bootstrap.ts',
      }),
    ]);
  });

  it('非 CI Review 内容不进入结构化解析', () => {
    expect(isCiReviewBody('普通 reviewer 评论')).toBe(false);
    expect(parseStructuredCiReview('普通 reviewer 评论')).toBeNull();
  });
});
