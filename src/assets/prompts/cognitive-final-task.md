请从以下候选方案中选择最优方案，并输出最终决策。

## 问题
- 文件：{{findingFile}}:{{findingLine}}
- 描述：{{findingMessage}}
- 建议：{{findingSuggestion}}

## 候选方案
{{options}}

{{fileOverview}}
{{extraFileContexts}}
{{relatedMemories}}

{{include:shared/action-descriptions}}

决策原则：
{{include:shared/maintainer-decision-principles}}

{{include:shared/json-only-constraint}}

请输出 JSON：
{
  "action": "fix" | "ask" | "ignore",
  "reason": "简要说明",
  "question": "ask 时的问题",
  "fixDescription": "fix 时的描述",
  "deleteFile": true|false,
  "scope": "trivial|local|cross-file",
  "analysis": "问题分析",
  "consideredOptions": ["方案1", "方案2"],
  "reasoning": "选择最优方案的原因",
  "confidence": "high|medium|low",
  "alreadyFixed": true|false,
  "replyBody": "ignore 且 alreadyFixed=true 时，向 Reviewer 说明问题已修复的回复正文"
}
