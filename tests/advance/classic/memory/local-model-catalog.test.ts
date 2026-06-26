import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_RERANK_MODEL,
  EMBEDDING_MODELS,
  RERANK_MODELS,
  isValidHuggingFaceModelId,
} from '../../../../src/advance/classic/memory/local-model-catalog.js';

describe('local-model-catalog', () => {
  it('有默认模型', () => {
    expect(DEFAULT_EMBEDDING_MODEL).toBe('intfloat/multilingual-e5-small');
    expect(DEFAULT_RERANK_MODEL).toBe('BAAI/bge-reranker-base');
  });

  it('内置清单包含默认模型', () => {
    expect(EMBEDDING_MODELS).toContain(DEFAULT_EMBEDDING_MODEL);
    expect(RERANK_MODELS).toContain(DEFAULT_RERANK_MODEL);
  });

  it('校验合法 HuggingFace 模型名', () => {
    expect(isValidHuggingFaceModelId('BAAI/bge-reranker-base')).toBe(true);
    expect(isValidHuggingFaceModelId('intfloat/multilingual-e5-small')).toBe(true);
  });

  it('拒绝非法模型名', () => {
    expect(isValidHuggingFaceModelId('')).toBe(false);
    expect(isValidHuggingFaceModelId('model;rm -rf /')).toBe(false);
    expect(isValidHuggingFaceModelId('../../etc/passwd')).toBe(false);
  });
});
