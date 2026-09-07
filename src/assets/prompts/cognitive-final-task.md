请从以下候选方案中选择最优方案，并输出最终决策。

## 问题
- 文件：{{findingFile}}:{{findingLine}}
- 描述：{{findingMessage}}
- 建议：{{findingSuggestion}}

## 候选方案
{{options}}

## 当前文件内容
{{fileContent}}

{{fileOverview}}
{{extraFileContexts}}
{{relatedMemories}}

## 红队评审
{{adversarialReview}}

## 红队修订要求
{{adversarialFollowUp}}

{{include:shared/action-descriptions}}

决策原则：
{{include:shared/maintainer-decision-principles}}

必须回应红队提出的每个关键疑虑。若根因、影响范围或验证标准仍不确定，应选择 `ask`，不要用一个看似合理的局部修改掩盖不确定性。`fix` 时只能批准确实需要修改的最小文件集合，并给出提交前必须完成的验证步骤；`ignore` 时必须明确是已经修复还是无需处理。

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
  "notActionable": true|false,
  "replyBody": "ignore 时向 Reviewer 说明已修复或无需处理的具体理由",
  "affectedFiles": ["最终批准修改的文件路径"],
  "verificationPlan": ["提交前必须完成的验证步骤"],
  "risks": ["仍存在的风险或控制措施"],
  "adversarialResponses": ["逐项回应一条红队意见：说明意见、处理方式和用于证明已处理的验证；不要只写‘已处理’"]
}

当红队提出关键意见时，`adversarialResponses` 中必须逐项回应；红队原始意见由框架单独保存，不能把主模型回应冒充为 `adversarialConcerns`。`verificationPlan` 必须包含可执行的提交前验证步骤。若无法完成回应，应选择 `ask`，不要声称可以安全修复。
