/**
 * ask-gate 单元测试（L2）
 *
 * 正面夹具取材自 example_desktop MR !1558 的真实索问。
 */

import { describe, it, expect } from 'vitest';
import { isSelfAnswerableQuestion, isRepoContentReply } from '../../../../src/advance/classic/fix/ask-gate.js';

describe('isSelfAnswerableQuestion', () => {
  it('!1558 现场：索要仓库内文件内容被拦截', () => {
    expect(
      isSelfAnswerableQuestion(
        '请提供 packages/example-memory/src/core/foundation/telemetry/tracker.ts 文件的内容，以便分析全局 tracker 的当前实现，以及评估三种修复方案对 telemetry 模块的影响。'
      )
    ).toBe(true);
  });

  it('请贴出代码片段被拦截', () => {
    expect(isSelfAnswerableQuestion('请贴出 memoryFacade.ts 中 dispose 方法的代码片段')).toBe(true);
  });

  it('能否提供 xx 的实现被拦截', () => {
    expect(isSelfAnswerableQuestion('能否提供一下 sink 注册部分的实现？')).toBe(true);
  });

  it('英文索要文件内容被拦截', () => {
    expect(isSelfAnswerableQuestion('Could you please provide the content of tracker.ts?')).toBe(
      true
    );
  });

  it('意图澄清类问题放行（真正需要人回答）', () => {
    expect(isSelfAnswerableQuestion('我尝试自动修复但未成功，请补充期望的修改方式或范围。')).toBe(
      false
    );
    expect(isSelfAnswerableQuestion('这个全局 reset 是有意设计还是历史遗留？')).toBe(false);
    expect(isSelfAnswerableQuestion('多实例场景下是否允许遥测数据丢失？')).toBe(false);
  });

  it('空问题放行', () => {
    expect(isSelfAnswerableQuestion('')).toBe(false);
  });
});


describe('isRepoContentReply（G7 漏判候选信号）', () => {
  it('含代码围栏的回复判定为仓库内容', () => {
    expect(isRepoContentReply('可以直接这样改：\n```ts\nresetTracker(this);\n```')).toBe(true);
  });

  it('含文件路径引用的回复判定为仓库内容', () => {
    expect(isRepoContentReply('参考 packages/core/src/tracker.ts:913 的 dispose 实现')).toBe(true);
    expect(isRepoContentReply('配置在 config/deploy.yaml 里')).toBe(true);
  });

  it('纯方案讨论/意图澄清回复不判定为仓库内容', () => {
    expect(isRepoContentReply('保留兼容旧接口，按方案二处理')).toBe(false);
    expect(isRepoContentReply('这是有意设计，多实例场景允许丢失')).toBe(false);
  });

  it('空回复不判定为仓库内容', () => {
    expect(isRepoContentReply('')).toBe(false);
  });
});
