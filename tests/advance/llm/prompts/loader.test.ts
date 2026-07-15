import { describe, it, expect, beforeEach } from 'vitest';
import { FilePromptLoader } from '../../../../src/advance/llm/prompts/loader.js';

describe('FilePromptLoader', () => {
  let loader: FilePromptLoader;

  beforeEach(() => {
    loader = new FilePromptLoader();
  });

  it('register 覆盖磁盘加载', () => {
    loader.register('test', 'hello {{name}}');
    expect(loader.load('test', { name: 'world' })).toBe('hello world');
  });

  it('支持变量替换', () => {
    loader.register('vars', '文件: {{file}}, 行号: {{line}}');
    expect(loader.load('vars', { file: 'src/a.ts', line: '10' })).toBe('文件: src/a.ts, 行号: 10');
  });

  it('变量缺失时抛出明确错误', () => {
    loader.register('missing', '需要 {{value}}');
    expect(() => loader.load('missing', {})).toThrow('Prompt 变量未提供: value');
  });

  it('支持 include 共享 fragment', () => {
    loader.register('shared/greeting', '你好');
    loader.register('main', '{{include:shared/greeting}}，{{name}}');
    expect(loader.load('main', { name: 'SobertLi' })).toBe('你好，SobertLi');
  });

  it('支持嵌套 include', () => {
    loader.register('shared/a', 'A');
    loader.register('shared/b', '{{include:shared/a}}B');
    loader.register('main', '{{include:shared/b}}C');
    expect(loader.load('main', {})).toBe('ABC');
  });

  it('检测到 include 循环引用时抛出错误', () => {
    loader.register('a', '{{include:b}}');
    loader.register('b', '{{include:a}}');
    expect(() => loader.load('a', {})).toThrow('循环引用');
  });

  it('register 支持带 .md 后缀的名称', () => {
    loader.register('shared/foo.md', 'bar');
    expect(loader.load('shared/foo', {})).toBe('bar');
  });
});
