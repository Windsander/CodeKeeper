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

/**
 * 已知 embedding 模型的输出维度。
 *
 * 用于向 EverOS 注入 EVEROS_EMBEDDING__DIM，使 LanceDB vector 列维度
 * 与当前模型实际输出维度一致，避免维度不匹配报错。
 */
export const EMBEDDING_MODEL_DIMENSIONS: Record<string, number> = {
  [DEFAULT_EMBEDDING_MODEL]: 384,
  'BAAI/bge-small-en-v1.5': 384,
  'BAAI/bge-small-zh-v1.5': 384,
  'sentence-transformers/all-MiniLM-L6-v2': 384,
};

/**
 * 获取指定 embedding 模型的输出维度；未知模型默认 384。
 */
export function getEmbeddingModelDimension(model: string): number {
  return EMBEDDING_MODEL_DIMENSIONS[model] ?? 384;
}

/**
 * 从 HuggingFace 拉取 embedding 模型的 config.json，解析 hidden_size 作为维度。
 *
 * 对 sentence-transformers 类模型，hidden_size 通常就是输出向量维度。
 * 拉取失败时返回 null，调用方应回退到本地缓存或默认值。
 */
export async function fetchEmbeddingModelDimension(modelId: string): Promise<number | null> {
  const cached = EMBEDDING_MODEL_DIMENSIONS[modelId];
  if (cached !== undefined) {
    return cached;
  }

  const url = `https://huggingface.co/${modelId}/raw/main/config.json`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      return null;
    }
    const config = await res.json() as { hidden_size?: number };
    if (typeof config.hidden_size === 'number' && config.hidden_size > 0) {
      return config.hidden_size;
    }
  } catch {
    // 网络失败或 JSON 解析失败都静默回退
  }
  return null;
}

// HuggingFace repo id 规则：namespace/model-name，允许字母、数字、-、_、.
const HF_MODEL_ID_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?\/[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

export function isValidHuggingFaceModelId(model: string): boolean {
  return HF_MODEL_ID_RE.test(model);
}
