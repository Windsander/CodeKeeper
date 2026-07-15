请根据 Reviewer 在 MR discussion 中提出的所有问题，生成一份统一的修复计划。

## Reviewer 原评论
{{originalComment}}

## 需要修复的问题
{{findingSections}}

## 相关文件完整内容
{{fileSections}}

## 输出要求
请输出 JSON：
{
  "reason": "简要说明整体修复思路",
  "patches": [
    {
      "filePath": "相对路径",
      "patch": "标准 unified diff 补丁（包含 diff --git、---、+++、@@ 行）"
    }
  ]
}

注意：
- 每个 patch 必须是标准 unified diff 格式。
- hunk 行号必须对应上面给出的完整文件内容。
- 只修改与问题相关的行，保持补丁最小化。
- 同一个文件的多处修改可以合并到一个 patch 的多个 hunk 中，也可以分成多个 patch。
- 如果某个 finding 无法安全修复，可以省略对应的 patch，并在 reason 中说明。
