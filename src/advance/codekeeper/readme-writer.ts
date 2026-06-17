import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ReadmeWriterOptions {
  archiveRoot: string;
}

/**
 * 生成 README.md 到归档位置，说明目录内各文件用途
 */
export function writeReadme(options: ReadmeWriterOptions): void {
  const dir = options.archiveRoot;
  mkdirSync(dir, { recursive: true });

  const lines: string[] = [
    '# CodeKeeper 归档目录说明',
    '',
    '本目录由 CodeKeeper Advance 自动生成与维护，采用"图书管理员"模式：',
    '- **原始项目文件不会被修改或删除**，仅被复制到本归档目录。',
    '- 归档文件按 `<category>/<docType>/<YYYY-MM>/<filename>` 结构自动归类。',
    '- 每次扫描都会重新评估归档结构，必要时在归档目录内部重新组织（organize）。',
    '- 源文件删除后，归档副本会保留并标记为 `orphaned`。',
    '',
    '## 文件清单',
    '',
    '| 文件 | 用途 | 消费方 |',
    '|------|------|--------|',
    '| README.md | 本说明 | 人类 / Agent |',
    '| context.md | 已归档知识条目索引，按 category 分组 | Agent 查询、RAG 上下文 |',
    '| suggestions.md | 归档动作日志，按风险等级分组 | 人工 review、Agent 审计 |',
    '| status.json | 项目实时状态（计数、健康度、扫描时间） | Agent 状态判断、面板展示 |',
    '| config.yaml | 项目级配置（包含/排除规则、自定义名称等） | 守护进程、归档管道 |',
    '',
    '## 目录结构',
    '',
    '```',
    '<archiveRoot>/',
    '  README.md',
    '  context.md',
    '  suggestions.md',
    '  status.json',
    '  config.yaml',
    '  <category>/',
    '    <docType>/',
    '      <YYYY-MM>/',
    '        <filename>',
    '```',
    '',
    '## 消费指南',
    '',
    '### context.md',
    '',
    '- 按 Markdown 标题分组，每个 category 是一个 ## 二级标题。',
    '- 条目链接指向归档目录内的相对路径。',
    '- 状态标签说明：',
    '  - (已归档)：正常归档',
    '  - (已忽略)：被判定为无需归档',
    '  - (已孤儿)：源文件已删除，归档副本保留',
    '',
    '### suggestions.md',
    '',
    '- 记录每一次自动执行的归档动作。',
    '- 高风险动作优先展示，供人工 review。',
    '',
    '### status.json',
    '',
    '- schemaVersion：状态格式版本号（当前为 2）。',
    '- scanStatus：最近一次扫描结果，取值 success / partial / failed。',
    '- healthScore：已处理条目占总条目数的比例，范围 0-1。',
    '- copiedCount / organizedCount / flaggedCount / orphanedCount：各类动作计数。',
    '',
    '## 注意事项',
    '',
    '- 请勿手动移动或删除归档目录内的文件，下次扫描时可能会重新生成或标记状态。',
    '- 如需调整分类、包含/排除规则，请修改 config.yaml 后重新扫描。',
  ];

  writeFileSync(join(dir, 'README.md'), lines.join('\n') + '\n', 'utf-8');
}
