import { describe, it, expect } from 'vitest';
import { defaultPromptLoader } from '../../../../src/advance/llm/prompts/loader.js';

/**
 * Prompt 资产冒烟测试
 *
 * 确保 Phase 1~4 外置的关键 Markdown 文件存在，且变量能正确替换。
 */
describe('prompt assets', () => {
  it('reviewer-system 存在', () => {
    const content = defaultPromptLoader.load('reviewer-system');
    expect(content).toContain('JSON');
  });

  it('reviewer-review-task 变量可替换', () => {
    const content = defaultPromptLoader.load('reviewer-review-task', {
      mrTitle: 'T',
      mrDescription: 'D',
      mrSourceBranch: 'S',
      mrTargetBranch: 'M',
      rules: 'R',
      soulSection: '',
      contextSection: '',
      recalledContext: '',
      diffText: 'diff',
    });
    expect(content).toContain('MR 标题: T');
    expect(content).toContain('```diff\ndiff\n```');
  });

  it('reviewer-reply-task 变量可替换', () => {
    const content = defaultPromptLoader.load('reviewer-reply-task', {
      mrTitle: 'T',
      mrDescription: 'D',
      mrSourceBranch: 'S',
      mrTargetBranch: 'M',
      findingsText: 'F',
      notesText: 'N',
      recalledContext: '',
      targetAuthor: 'A',
      targetCreatedAt: 'C',
      targetBody: 'B',
      rules: 'R',
      soulSection: '',
      contextSection: '',
    });
    expect(content).toContain('【待回复】A (C):');
    expect(content).toContain('B');
  });

  it('recall-decision 变量可替换', () => {
    const content = defaultPromptLoader.load('recall-decision', {
      role: 'reviewer',
      taskType: 'review',
      taskSummary: 'summary',
      availableFindings: '',
      availableRecallTypes: 'review, project_knowledge',
    });
    expect(content).toContain('当前角色：reviewer');
    expect(content).toContain('summary');
    expect(content).toContain('review, project_knowledge');
  });

  it('cross-file-plan 变量可替换', () => {
    const content = defaultPromptLoader.load('cross-file-plan', {
      findingFile: 'a.ts',
      findingLine: '1',
      findingMessage: 'm',
      findingSuggestion: 's',
      snippetStartLine: '1',
      snippetEndLine: '2',
      snippet: 'code',
    });
    expect(content).toContain('问题文件：a.ts');
    expect(content).toContain('code');
  });

  it('batch-fix-plan 变量可替换', () => {
    const content = defaultPromptLoader.load('batch-fix-plan', {
      originalComment: 'oc',
      findingSections: 'fs',
      fileSections: 'fcs',
    });
    expect(content).toContain('oc');
    expect(content).toContain('fs');
    expect(content).toContain('fcs');
  });

  it('issue-scope-confirm 变量可替换', () => {
    const content = defaultPromptLoader.load('issue-scope-confirm', {
      findingFile: 'a.ts',
      findingLine: '1',
      findingMessage: 'm',
      findingSuggestion: 's',
      snippetStartLine: '1',
      snippetEndLine: '2',
      snippet: 'code',
    });
    expect(content).toContain('a.ts');
    expect(content).toContain('trivial|local|cross-file|needs-clarification');
  });

  it('context-window-summary 变量可替换', () => {
    const content = defaultPromptLoader.load('context-window-summary', { notesText: 'notes' });
    expect(content).toContain('notes');
    expect(content).toContain('摘要：');
  });

  it('archiver-analyze 变量可替换', () => {
    const content = defaultPromptLoader.load('archiver-analyze', {
      projectName: 'p',
      projectRootPath: 'virtual-workspace/project',
      filePaths: '- a\n- b',
      fileContents: '',
    });
    expect(content).toContain('项目名称: p');
    expect(content).toContain('- a');
    expect(content).toContain('- b');
  });

  it('fix-tool-loop 各提醒 prompt 存在', () => {
    expect(defaultPromptLoader.load('fix-tool-loop-budget-reminder')).toContain('剩余步数');
    expect(defaultPromptLoader.load('fix-tool-loop-truncation-reminder')).toContain('截断');
    expect(defaultPromptLoader.load('fix-tool-loop-no-tool-reminder')).toContain('工具');
    expect(defaultPromptLoader.load('fix-tool-loop-stale-reminder')).toContain('陷入循环');
    expect(defaultPromptLoader.load('fix-tool-loop-read-only-reminder')).toContain('只读探索');
    expect(
      defaultPromptLoader.load('fix-tool-loop-read-only-failure-reason', {
        steps: '3',
        verdictReason: '问题仍存在',
        verdictEvidence: '第 25 行未见修改',
      })
    ).toContain('3');
    expect(
      defaultPromptLoader.load('fix-tool-loop-final-acting-round', {
        steps: '3',
        verdictReason: '问题仍存在',
        verdictEvidence: '第 25 行未见修改',
      })
    ).toContain('最后 3 步');
    expect(defaultPromptLoader.load('fix-tool-loop-unchanged-finish-reminder')).toContain(
      '没有检测到'
    );
    expect(
      defaultPromptLoader.load('fix-tool-loop-stale-failure-reason', { steps: '3' })
    ).toContain('3');
    expect(
      defaultPromptLoader.load('fix-tool-loop-validation-failure-reason', { reason: 'r' })
    ).toContain('r');
    expect(defaultPromptLoader.load('fix-tool-loop-no-change-failure-reason')).toContain(
      '未实际修改'
    );
  });

  it('maintainer 回复模板 prompt 变量可替换', () => {
    const alreadyFixed = defaultPromptLoader.load('maintainer-already-fixed-reply', {
      maintainerName: 'Bot',
      replyBody: '已经修复',
    });
    expect(alreadyFixed).toContain('Bot');
    expect(alreadyFixed).toContain('已经修复');

    const ignored = defaultPromptLoader.load('maintainer-ignore-reply', {
      maintainerName: 'Bot',
      reason: '无需处理',
    });
    expect(ignored).toContain('Bot');
    expect(ignored).toContain('无需处理');

    const deleteFailed = defaultPromptLoader.load('maintainer-delete-failed-ask', { file: 'a.ts' });
    expect(deleteFailed).toContain('a.ts');

    const fixFailed = defaultPromptLoader.load('maintainer-fix-failed-ask', { fileLine: 'a.ts:1' });
    expect(fixFailed).toContain('a.ts:1');

    expect(defaultPromptLoader.load('maintainer-ask-clarify')).toContain('修改方式');
  });

  it('maintainer-statistical-report-task 变量可替换', () => {
    const content = defaultPromptLoader.load('maintainer-statistical-report-task', {
      body: 'ESLint Report\nTop files\n...',
    });
    expect(content).toContain('ESLint Report');
    expect(content).toContain('statistical_report_decision');
  });
});
