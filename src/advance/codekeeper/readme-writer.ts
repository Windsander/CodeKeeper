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
    '本目录由 CodeKeeper Advance 自动生成与维护，用于向各 Agent 提供项目知识上下文、归档建议与处理状态。',
    '',
    '## 文件清单',
    '',
    '| 文件 | 用途 | 消费方 |',
    '|------|------|--------|',
    '| README.md | 本说明 | 人类 / Agent |',
    '| context.md | 已归档知识条目，按 category 分组 | Agent 查询、RAG 上下文 |',
    '| suggestions.md | 中高风险归档建议，需人工或 Agent 审查后执行 | Agent 决策、人类 review |',
    '| status.json | 项目实时状态（计数、健康度、扫描时间） | Agent 状态判断、面板展示 |',
    '| config.yaml | 项目级配置（包含/排除规则、自定义名称等） | 守护进程、归档管道 |',
    '',
    '## 消费指南',
    '',
    '### context.md',
    '',
    '- 按 Markdown 标题分组，每个 category 是一个 ## 二级标题。',
    '- 条目使用相对路径的 Markdown 链接，可直接定位到源文件。',
    '- 状态标签说明：',
    '  - (已归档)：已完成归档',
    '  - (已忽略)：被判定为无需归档',
    '  - (待处理)：处理失败或需要重试',
    '',
    '### suggestions.md',
    '',
    '- 高风险建议优先展示。',
    '- 每条建议包含唯一 ID，Agent 可通过 ID 引用并反馈接受/拒绝。',
    '- 如需自动执行 low risk 建议，请运行 codekeeper-advance process --api-key <KEY> <PROJECT_PATH>。',
    '',
    '### status.json',
    '',
    '- schemaVersion：状态格式版本号。',
    '- scanStatus：最近一次扫描结果，取值 success / partial / failed。',
    '- healthScore：已处理条目占总条目数的比例，范围 0-1。',
    '- healthScoreDefinition：健康度计算说明。',
    '',
    '## 注意事项',
    '',
    '- 请勿手动修改本目录内由生成器写入的文件（config.yaml 除外），下次扫描时会被覆盖。',
    '- 如需调整分类、风险阈值或输出格式，请修改项目配置或归档引擎配置。',
  ];

  writeFileSync(join(dir, 'README.md'), lines.join('\n') + '\n', 'utf-8');
}
