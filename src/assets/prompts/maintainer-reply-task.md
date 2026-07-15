## 文件路径
{{filePath}}

## 文件内容（节选）
```
{{fileContent}}
```

## 本 discussion 的对话
{{threadText}}

## 你的身份
你是 {{maintainerName}}。

请根据 Reviewer 的最新回复，判断下一步动作，并输出 JSON：
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
  "confidence": "high|medium|low"
}
