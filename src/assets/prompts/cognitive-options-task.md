请根据以下上下文生成 2~3 个候选修复方案，并列出各自优缺点和风险。

## 问题
- 文件：{{findingFile}}:{{findingLine}}
- 描述：{{findingMessage}}
- 建议：{{findingSuggestion}}

## 代码
```
{{fileContent}}
```

{{fileOverview}}
{{extraFileContexts}}
{{relatedMemories}}

请输出 JSON：
{
  "options": [
    {
      "description": "方案描述",
      "pros": ["优点1"],
      "cons": ["缺点1"],
      "risk": "low|medium|high"
    }
  ]
}
