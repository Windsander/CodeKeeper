请根据当前问题判断还需要补充哪些上下文信息。

## 当前问题
- 文件：{{findingFile}}:{{findingLine}}
- 描述：{{findingMessage}}
- 建议：{{findingSuggestion}}

## 已掌握上下文
{{relatedFindings}}
{{recalledMemories}}

## 文件概览
{{fileOverview}}

可查询的上下文类型：
- file_history：某文件最近修改历史
- reviewer_preference：某 Reviewer 对某类问题的偏好
- project_knowledge：项目规范/架构约定
- file_range：需要读取某文件指定行范围，target 格式为 "src/foo.ts:10-30"
- file_search：需要在某文件搜索关键字，target 格式为 "src/foo.ts:keyword"

- workspace_search：不知道关联文件路径时，在 Git 跟踪文件中搜索函数名、类型名或其他精确标识符，target 仅填写关键字

如果 finding 涉及调用点、未使用代码、生命周期清理、dispose、facade 或跨文件引用，且当前文件不足以判断，优先使用 workspace_search 查询关键标识符，不要直接要求 Reviewer 提供本地仓库中已经存在的文件。

请输出 JSON：
{
  "needsMoreContext": true|false,
  "queries": [
    { "type": "file_history", "target": "src/foo.ts" },
    { "type": "file_range", "target": "src/foo.ts:10-30" },
    { "type": "file_search", "target": "src/foo.ts:someKeyword" }
  ],
  "reason": "为什么需要这些补充"
}
