请对以下 Merge Request 进行代码评审。

MR 标题: {{mrTitle}}
MR 描述: {{mrDescription}}
源分支: {{mrSourceBranch}} -> 目标分支: {{mrTargetBranch}}

评审规则:
{{rules}}{{soulSection}}{{contextSection}}{{recalledContext}}

变更内容:
```diff
{{diffText}}
```

请严格按照以下 JSON 格式输出评审结果，不要包含任何其他文字:

{
  "findings": [
    {
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "file": "文件路径",
      "line": 行号,
      "ruleId": "规则编号（可选）",
      "message": "问题描述",
      "suggestion": "修改建议",
      "autoFixable": true|false
    }
  ],
  "summary": "整体评审总结",
  "autoFixable": [0, 1, ...]
}

如果没有发现问题，findings 为空数组，summary 简要说明。
