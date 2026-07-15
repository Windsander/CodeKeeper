请分析以下项目文件，提炼出可用于代码评审和维护的项目知识。

项目名称: {{projectName}}
项目根目录: {{projectRootPath}}

关键文件路径：
{{filePaths}}

请输出 JSON 数组，每个元素包含：
{
  "id": "唯一标识（建议用 category+简短英文）",
  "category": "convention|architecture|domain|risk|stack",
  "sourceFiles": ["相关文件路径"],
  "content": "知识内容（中文）",
  "confidence": "low|medium|high"
}

只输出 JSON，不要解释。
