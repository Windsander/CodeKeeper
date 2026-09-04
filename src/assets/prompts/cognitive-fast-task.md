## 文件路径
{{findingFile}}

先判断问题是否已经修复或无需处理；只有确认仍需修改时才选择 `fix`。如果选择 `fix`，必须说明根因、最小影响文件集合和可验证的完成标准。

{{fileOverview}}
## 相关代码
```
{{fileContent}}
```

{{extraFileContexts}}
## Reviewer 评论
{{originalComment}}

## 解析出的 finding
- 严重程度：{{findingSeverity}}
{{findingRuleIdLine}}
- 行号：{{findingLine}}
- 问题描述：{{findingMessage}}
- 修改建议：{{findingSuggestion}}

{{relatedMemories}}

{{include:shared/action-descriptions}}

决策原则：
{{include:shared/maintainer-decision-principles}}

{{include:shared/json-only-constraint}}

请输出 JSON：
{
  "action": "fix" | "ask" | "ignore",
  "reason": "简要说明理由",
  "question": "如果 action=ask，填写问题",
  "fixDescription": "如果 action=fix，可选描述",
  "deleteFile": "如果 action=fix 且需要删除文件，填 true",
  "scope": "trivial|local|cross-file",
  "analysis": "对问题的分析",
  "consideredOptions": ["方案1", "方案2"],
  "reasoning": "最终选择该方案的原因",
  "confidence": "high|medium|low",
  "alreadyFixed": "如果问题已被修复，填 true",
  "notActionable": "如果问题是误报、重复项或按约定无需修改，填 true",
  "replyBody": "ignore 时，向 Reviewer 说明已修复或无需处理的具体证据",
  "affectedFiles": ["fix 时最终需要修改的文件路径"],
  "verificationPlan": ["fix 后必须执行的验证步骤"],
  "risks": ["风险或控制措施"],
  "adversarialConcerns": ["已识别的关键疑虑"]
}
