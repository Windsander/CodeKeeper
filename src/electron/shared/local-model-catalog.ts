// 注意：本文件是 src/advance/classic/memory/local-model-catalog.ts 的副本，
// 用于 Electron renderer 进程（tsconfig rootDir 限制）。
// 修改时请同步更新两个文件。

export const DEFAULT_EMBEDDING_MODEL = 'intfloat/multilingual-e5-small';
export const DEFAULT_RERANK_MODEL = 'BAAI/bge-reranker-base';

export const EMBEDDING_MODELS = [
  DEFAULT_EMBEDDING_MODEL,
  'BAAI/bge-small-en-v1.5',
  'BAAI/bge-small-zh-v1.5',
  'sentence-transformers/all-MiniLM-L6-v2',
];

export const RERANK_MODELS = [
  DEFAULT_RERANK_MODEL,
  'BAAI/bge-reranker-v2-m3',
  'mixedbread-ai/mxbai-rerank-xsmall-v1',
];

// HuggingFace repo id 规则：namespace/model-name，允许字母、数字、-、_、.
const HF_MODEL_ID_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?\/[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

export function isValidHuggingFaceModelId(model: string): boolean {
  return HF_MODEL_ID_RE.test(model);
}
