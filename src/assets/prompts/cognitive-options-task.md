请根据以下上下文生成 2~3 个候选修复方案，并列出各自优缺点和风险。

先理解 Reviewer 真正指出的根因，再生成方案。方案可以否定 Reviewer 的具体实现建议，但必须解决原始问题；不要为了凑数量生成没有意义的方案。每个方案必须明确最小影响文件集合和可观察的验证步骤。

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
      "risk": "low|medium|high",
      "affectedFiles": ["src/foo.ts"],
      "verificationSteps": ["运行测试并确认错误路径不再出现"]
    }
  ]
}
