/**
 * Prompt 资产加载器
 *
 * 将 LLM 自然语言 prompt 外置到 src/assets/prompts/ 下的 Markdown 文件，
 * 支持变量替换 `{{variable}}` 和 fragment 包含 `{{include:shared/fragment}}`。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface PromptLoader {
  /** 加载指定 prompt 并替换变量 */
  load(name: string, variables?: Record<string, string>): string;
  /** 在内存中注册/覆盖某个 prompt，测试常用 */
  register(name: string, content: string): void;
  /** 设置资产根目录，默认按 __dirname 自动推导 */
  setAssetDir(assetDir: string): void;
}

export interface FilePromptLoaderOptions {
  assetDir?: string;
}

export class FilePromptLoader implements PromptLoader {
  private assetDir?: string;
  private readonly registry = new Map<string, string>();

  constructor(options: FilePromptLoaderOptions = {}) {
    this.assetDir = options.assetDir;
  }

  setAssetDir(assetDir: string): void {
    this.assetDir = assetDir;
  }

  register(name: string, content: string): void {
    this.registry.set(this.normalizeName(name), content);
  }

  load(name: string, variables: Record<string, string> = {}): string {
    const normalized = this.normalizeName(name);
    const raw = this.registry.get(normalized) ?? this.readFromDisk(normalized);
    return this.resolve(raw, variables, new Set([normalized]));
  }

  private normalizeName(name: string): string {
    // 允许带 .md 后缀，也允许不带
    return name.endsWith('.md') ? name.slice(0, -3) : name;
  }

  private readFromDisk(name: string): string {
    const dir = this.assetDir ?? this.defaultAssetDir();
    const filePath = join(dir, `${name}.md`);
    if (!existsSync(filePath)) {
      throw new Error(`Prompt 文件不存在: ${filePath}`);
    }
    return readFileSync(filePath, 'utf-8');
  }

  private defaultAssetDir(): string {
    // loader.ts 位于 src/advance/llm/prompts/，资产目录为 src/assets/prompts
    // 编译后位于 dist/advance/llm/prompts/，资产目录为 dist/assets/prompts
    return join(dirname(__dirname), '..', '..', 'assets', 'prompts');
  }

  private resolve(
    raw: string,
    variables: Record<string, string>,
    resolving: Set<string>
  ): string {
    // 先处理 include，再处理变量，避免变量值里出现 include 被误解析
    let result = this.resolveIncludes(raw, variables, resolving);
    result = this.substituteVariables(result, variables);
    return result;
  }

  private resolveIncludes(
    raw: string,
    variables: Record<string, string>,
    resolving: Set<string>
  ): string {
    const includePattern = /\{\{include:([^}]+)\}\}/g;
    return raw.replace(includePattern, (_match, includeName: string) => {
      const normalized = this.normalizeName(includeName.trim());
      if (resolving.has(normalized)) {
        throw new Error(`Prompt include 循环引用: ${Array.from(resolving).join(' -> ')} -> ${normalized}`);
      }
      const content = this.registry.get(normalized) ?? this.readFromDisk(normalized);
      const nextResolving = new Set(resolving);
      nextResolving.add(normalized);
      return this.resolve(content, variables, nextResolving);
    });
  }

  private substituteVariables(raw: string, variables: Record<string, string>): string {
    const varPattern = /\{\{([^{}:]+)\}\}/g;
    return raw.replace(varPattern, (_match, key: string) => {
      const trimmed = key.trim();
      if (!(trimmed in variables)) {
        throw new Error(`Prompt 变量未提供: ${trimmed}`);
      }
      return variables[trimmed];
    });
  }
}

/** 全局默认 loader 实例，供大多数模块直接使用 */
export const defaultPromptLoader = new FilePromptLoader();
