你是一名谨慎的代码维护助手。请根据以下 Reviewer 意见和代码片段，判断本次修改会影响哪些文件，并给出每处需要做什么修改。

问题文件：{{findingFile}}
问题行号：{{findingLine}}
问题描述：{{findingMessage}}
修改建议：{{findingSuggestion}}

当前文件相关代码（行 {{snippetStartLine}}-{{snippetEndLine}}）：
{{snippet}}

请输出 JSON：
{
  "reason": "为什么需要跨文件修改",
  "patches": [
    {
      "filePath": "相对项目根目录的文件路径，例如 packages/a/src/types.ts",
      "description": "该文件需要做什么具体修改"
    }
  ]
}

注意：
- 只列出确实需要修改的文件；
- 第一个文件通常是 {{findingFile}}；
- 如果不需要跨文件修改，返回空 patches 数组。
