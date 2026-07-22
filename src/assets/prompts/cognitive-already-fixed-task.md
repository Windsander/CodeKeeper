## 任务

判断 finding 描述的问题在当前代码中是否**已经修复/已不存在**。

## 定位信息

- 文件：`{{findingFile}}:{{findingLine}}`
- 描述：{{findingMessage}}
- 建议：{{findingSuggestion}}

## 代码（聚焦窗口）

```
{{fileContent}}
```

{{staleWarning}}
{{fileOverview}}
{{extraFileContexts}}

## 判断标准

1. **关注的是「finding 描述的问题是否还存在」，而不是「Reviewer 的建议是否被逐字采用」**。
   - 修复方式可以不是 Reviewer 提出的方法；只要当前代码已经不存在 finding 描述的问题，就返回 `alreadyFixed=true`。
2. 优先根据上面「代码（聚焦窗口）」中第 `{{findingLine}}` 行附近的代码判断。
3. 如果聚焦窗口里的代码**清楚显示问题已修复**，返回 `alreadyFixed=true`，并在 `evidence` 中给出具体证据（行号、代码片段）。
4. 如果聚焦窗口里的代码**清楚显示问题仍然存在**，返回 `alreadyFixed=false`，并在 `reason` 中说明问题在哪。
5. **如果聚焦窗口太窄，缺少判断所必需的上下文**（例如相关类型定义、imports、跨函数引用在窗口外看不到），不要猜测，请返回：
   - `alreadyFixed=false`
   - `needsMoreContext=true`
   - `reason` 中简要说明「缺少哪部分上下文导致无法判断」。

## 示例

- finding 说“缺少 `error?: number` 字段”，而聚焦代码中接口已定义 `error?: number` → `alreadyFixed=true`。
- finding 说“验证失败路径没有调用 tracker”，而聚焦代码中对应路径已调用 `memoryTracker.xxx(...)` → `alreadyFixed=true`。
- finding 说“需要增加 dispose 清理”，而聚焦代码中已存在等价的清理逻辑（即使函数名/位置与建议不同）→ `alreadyFixed=true`。
- finding 涉及的类型定义在当前聚焦窗口中看不到，必须看完整文件才能判断 → `alreadyFixed=false, needsMoreContext=true`。

{{include:shared/json-only-constraint}}

请输出 JSON：
{
  "alreadyFixed": true|false,
  "reason": "简要说明",
  "evidence": "具体证据（如第 X 行已包含 ...）",
  "needsMoreContext": true|false
}


## Additional constraints

- For findings about unused code, dead code, missing call sites, or placeholder definitions, seeing only the reported function, method, or interface definition is not evidence that the problem is fixed. Require a real call site, removal of the definition, or other direct evidence that eliminates the reported problem.
- `alreadyFixed=true` means the problem described by the finding no longer exists. It does not mean that the reviewer's suggestion was partially adopted or that the code merely looks reasonable. If evidence is insufficient, return `alreadyFixed=false` and explain what context is still needed.
