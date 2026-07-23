import { LlmClient } from '../../llm/client.js';
import type { Project } from '../../types.js';
import type { ProjectKnowledgeItem } from '../memory/types.js';
import { defaultPromptLoader, type PromptLoader } from '../../llm/prompts/loader.js';

export interface ProjectAnalyzer {
  name: string;
  analyze(project: Project, files: string[]): Promise<ProjectKnowledgeItem[]>;
}

export interface ArchiverBrainOptions {
  llmClient: LlmClient;
  analyzers?: ProjectAnalyzer[];
  /** 可选的 prompt 加载器，默认使用全局 loader */
  promptLoader?: PromptLoader;
}

/** 选出实际交给项目知识 LLM 的文件，并保证顺序稳定。 */
export function selectArchiverInputFiles(files: string[]): string[] {
  const priority = ['README', 'package.json', 'tsconfig', 'config.', '.eslintrc', 'CONTRIBUTING'];
  return files
    .map(file => ({
      file,
      score: priority.reduce(
        (total, keyword) =>
          file.toLowerCase().includes(keyword.toLowerCase()) ? total + 1 : total,
        0
      ),
    }))
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, 5)
    .map(item => item.file);
}

/**
 * Archiver 大脑：编排多个 Analyzer 提炼项目知识
 */
export class ArchiverBrain {
  private readonly analyzers: ProjectAnalyzer[];

  constructor(options: ArchiverBrainOptions) {
    this.analyzers = options.analyzers ?? [new LlmProjectAnalyzer(options.llmClient, options.promptLoader)];
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
  private readonly promptLoader: PromptLoader;

  constructor(private readonly llmClient: LlmClient, promptLoader?: PromptLoader) {
    this.promptLoader = promptLoader ?? defaultPromptLoader;
  }

  async analyze(project: Project, files: string[]): Promise<ProjectKnowledgeItem[]> {
    const keyFiles = selectArchiverInputFiles(files);
    if (keyFiles.length === 0) return [];

    const prompt = this.buildPrompt(project, keyFiles);
    const system = `你是项目知识整理助手。${this.promptLoader.load('shared/json-only-constraint')}`;
    const raw = await this.llmClient.complete(prompt, system);
    return this.parseResponse(raw);
  }

  private buildPrompt(project: Project, files: string[]): string {
    return this.promptLoader.load('archiver-analyze', {
      projectName: project.name,
      projectRootPath: project.rootPath,
      filePaths: files.map((f) => `- ${f}`).join('\n'),
    });
  }

  private parseResponse(raw: string): ProjectKnowledgeItem[] {
    try {
      const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)```/, '$1').trim();
      const parsed = JSON.parse(cleaned) as Array<Record<string, unknown>>;
      return parsed.map((item, index) => ({
        id: String(item.id ?? `knowledge-${index}`),
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
