## 文件路径
{{findingFile}}

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
  "replyBody": "ignore 且 alreadyFixed=true 时，向 Reviewer 说明已修复的具体证据"
}
