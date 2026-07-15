请从以下代码评审评论中提取所有可修复的代码问题，输出 JSON 对象。

评论内容：
{{body}}

{{positionHint}}

评论可能是以下格式之一：
1. Markdown 列表：
   - `src/a.ts:10` · 规则 `no-any` 类型不安全
     **修改建议**：使用具体类型
   - `src/b.ts:25` · 规则 `unused` 变量未使用
     **修改建议**：删除变量
2. 普通文本段落：
   "src/a.ts 第 10 行的 any 建议改成具体类型；另外 src/b.ts 第 25 行的变量未使用，建议删除。"
3. 对文件的描述性说明（可能包含多个具体问题）。

输出格式：
{
  "findings": [
    {
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "file": "文件路径",
      "line": 123,
      "ruleId": "可选的规则编号",
      "message": "问题描述",
      "suggestion": "修改建议",
      "autoFixable": true
    }
  ]
}

注意：
- 一条评论中可能包含多个问题，请全部提取。
- 如果评论里没有需要修复的代码问题，findings 为空数组。
- 如果评论是机器人签名、系统提示或 Maintainer 自己的回复，findings 为空数组。
- 当评论中没有明确文件路径时，使用上面提供的文件和行号作为兜底。
- 不要输出任何 JSON 以外的内容。
