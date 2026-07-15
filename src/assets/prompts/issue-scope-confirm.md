请判断以下代码评审问题的修改范围，只输出 JSON。

文件：{{findingFile}}
行号：{{findingLine}}
问题描述：{{findingMessage}}
修改建议：{{findingSuggestion}}
相关代码片段（行 {{snippetStartLine}}-{{snippetEndLine}}）：
{{snippet}}

请从以下范围中选一个，并给出理由：
- trivial：只需改一行/一个字段/一条注释，无风险。
- local：需要在一个函数或文件内做局部重构，但不出当前文件。
- cross-file：涉及类型定义、接口变更、函数签名变化，需要同时修改多个文件或调用点。
- needs-clarification：描述不清或需要 Reviewer 确认设计方向。

输出格式：
{
  "scope": "trivial|local|cross-file|needs-clarification",
  "reason": "一句话说明"
}
