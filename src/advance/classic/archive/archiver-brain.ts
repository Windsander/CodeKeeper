import { LlmClient } from '../../llm/client.js';
import type { Project } from '../../types.js';
import type { ProjectKnowledgeItem } from '../memory/types.js';

export interface ProjectAnalyzer {
  name: string;
  analyze(project: Project, files: string[]): Promise<ProjectKnowledgeItem[]>;
}

export interface ArchiverBrainOptions {
  llmClient: LlmClient;
  analyzers?: ProjectAnalyzer[];
}

/**
 * Archiver 大脑：编排多个 Analyzer 提炼项目知识
 */
export class ArchiverBrain {
  private readonly analyzers: ProjectAnalyzer[];

  constructor(options: ArchiverBrainOptions) {
    this.analyzers = options.analyzers ?? [new LlmProjectAnalyzer(options.llmClient)];
  }

  async analyzeProject(project: Project, files: string[]): Promise<ProjectKnowledgeItem[]> {
    const all: ProjectKnowledgeItem[] = [];
    for (const analyzer of this.analyzers) {
      const items = await analyzer.analyze(project, files);
      all.push(...items);
    }
    return this.deduplicate(all);
  }

  private deduplicate(items: ProjectKnowledgeItem[]): ProjectKnowledgeItem[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }
}

/**
 * 基于 LLM 的项目分析器
 */
export class LlmProjectAnalyzer implements ProjectAnalyzer {
  name = 'llm';

  constructor(private readonly llmClient: LlmClient) {}

  async analyze(project: Project, files: string[]): Promise<ProjectKnowledgeItem[]> {
    const keyFiles = this.selectKeyFiles(files);
    if (keyFiles.length === 0) return [];

    const prompt = this.buildPrompt(project, keyFiles);
    const raw = await this.llmClient.complete(prompt, '你是项目知识整理助手。请只输出 JSON。');
    return this.parseResponse(raw);
  }

  private selectKeyFiles(files: string[]): string[] {
    const priority = ['README', 'package.json', 'tsconfig', 'config.', '.eslintrc', 'CONTRIBUTING'];
    const scored = files.map((f) => {
      const score = priority.reduce((acc, keyword) => (f.toLowerCase().includes(keyword.toLowerCase()) ? acc + 1 : acc), 0);
      return { file: f, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 5).map((s) => s.file);
  }

  private buildPrompt(project: Project, files: string[]): string {
    return [
      '请分析以下项目文件，提炼出可用于代码评审和维护的项目知识。',
      `项目名称: ${project.name}`,
      `项目根目录: ${project.rootPath}`,
      '',
      '关键文件路径：',
      files.map((f) => `- ${f}`).join('\n'),
      '',
      '请输出 JSON 数组，每个元素包含：',
      '{',
      '  "id": "唯一标识（建议用 category+简短英文）",',
      '  "category": "convention|architecture|domain|risk|stack",',
      '  "sourceFiles": ["相关文件路径"],',
      '  "content": "知识内容（中文）",',
      '  "confidence": "low|medium|high"',
      '}',
      '',
      '只输出 JSON，不要解释。',
    ].join('\n');
  }

  private parseResponse(raw: string): ProjectKnowledgeItem[] {
    try {
      const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)```/, '$1').trim();
      const parsed = JSON.parse(cleaned) as Array<Record<string, unknown>>;
      return parsed.map((item) => ({
        id: String(item.id ?? `knowledge-${Date.now()}`),
        category: this.normalizeCategory(String(item.category ?? 'convention')),
        sourceFiles: Array.isArray(item.sourceFiles) ? item.sourceFiles.map(String) : [],
        content: String(item.content ?? ''),
        confidence: this.normalizeConfidence(String(item.confidence ?? 'medium')),
        createdAt: new Date().toISOString(),
      }));
    } catch (err) {
      console.error('[LlmProjectAnalyzer] 解析失败:', err, '原始响应:', raw);
      return [];
    }
  }

  private normalizeCategory(category: string): ProjectKnowledgeItem['category'] {
    const valid: ProjectKnowledgeItem['category'][] = ['convention', 'architecture', 'domain', 'risk', 'stack', 'graph'];
    const lower = category.toLowerCase();
    return valid.includes(lower as ProjectKnowledgeItem['category']) ? (lower as ProjectKnowledgeItem['category']) : 'convention';
  }

  private normalizeConfidence(confidence: string): ProjectKnowledgeItem['confidence'] {
    const valid: ProjectKnowledgeItem['confidence'][] = ['low', 'medium', 'high'];
    const lower = confidence.toLowerCase();
    return valid.includes(lower as ProjectKnowledgeItem['confidence']) ? (lower as ProjectKnowledgeItem['confidence']) : 'medium';
  }
}
