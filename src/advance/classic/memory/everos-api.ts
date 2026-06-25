import { sanitizeEverOSId } from './types.js';

/**
 * EverOS /api/v1/memory/add 请求参数
 */
export interface EverOSAddParams {
  appId: string;
  projectId: string;
  sessionId: string;
  senderId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

/**
 * 向 EverOS 写入一条记忆消息
 */
export async function everosMemoryAdd(everosUrl: string, params: EverOSAddParams): Promise<void> {
  const body = {
    app_id: sanitizeEverOSId(params.appId),
    project_id: sanitizeEverOSId(params.projectId),
    session_id: sanitizeEverOSId(params.sessionId),
    messages: [
      {
        sender_id: sanitizeEverOSId(params.senderId),
        role: params.role,
        timestamp: Date.now(),
        content: params.content,
      },
    ],
  };

  const res = await fetch(`${everosUrl}/api/v1/memory/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`EverOS memory/add 失败: ${res.status} ${await res.text()}`);
  }
}

/**
 * EverOS /api/v1/memory/search 的 owner 维度
 */
export type EverOSSearchOwner =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; agentId: string };

/**
 * EverOS /api/v1/memory/search 请求参数
 */
export interface EverOSSearchParams {
  appId: string;
  projectId: string;
  owner: EverOSSearchOwner;
  query: string;
  topK?: number;
  filters?: Record<string, unknown>;
}

/**
 * 召回条目（统一抽象，屏蔽 EverOS 内部 kind 差异）
 */
export interface EverOSSearchItem {
  id: string;
  type: string;
  content: string;
  source?: string;
  timestamp?: string;
  score?: number;
  sessionId?: string;
}

/**
 * EverOS /api/v1/memory/search 响应抽象
 */
export interface EverOSSearchResult {
  items: EverOSSearchItem[];
}

/**
 * 从 EverOS 召回记忆
 *
 * 按 agent_id 或 user_id 搜索，返回按 score 降序排列的文本摘要列表。
 */
export async function everosMemorySearch(
  everosUrl: string,
  params: EverOSSearchParams
): Promise<EverOSSearchResult> {
  const body: Record<string, unknown> = {
    app_id: sanitizeEverOSId(params.appId),
    project_id: sanitizeEverOSId(params.projectId),
    query: params.query,
    top_k: params.topK ?? 5,
    method: 'hybrid',
  };

  if (params.owner.kind === 'user') {
    body.user_id = sanitizeEverOSId(params.owner.userId);
    body.include_profile = true;
  } else {
    body.agent_id = sanitizeEverOSId(params.owner.agentId);
  }

  if (params.filters) {
    body.filters = params.filters;
  }

  const res = await fetch(`${everosUrl}/api/v1/memory/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`EverOS memory/search 失败: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { data?: Record<string, unknown> };
  const data = json.data ?? {};
  const items: EverOSSearchItem[] = [];

  const pushItems = (arr: unknown, type: string) => {
    if (!Array.isArray(arr)) return;
    for (const raw of arr) {
      const item = raw as Record<string, unknown> | undefined;
      if (!item) continue;
      const content = extractSearchContent(item, type);
      if (!content || content.trim().length === 0) continue;
      items.push({
        id: String(item.id ?? `${type}-${items.length}`),
        type,
        content,
        source: extractSource(item, type),
        timestamp: item.timestamp ? String(item.timestamp) : undefined,
        score: typeof item.score === 'number' ? item.score : undefined,
        sessionId: item.session_id ? String(item.session_id) : undefined,
      });
    }
  };

  pushItems(data.agent_cases, 'agent_case');
  pushItems(data.episodes, 'episode');
  pushItems(data.agent_skills, 'agent_skill');
  pushItems(data.profiles, 'profile');

  items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return { items };
}

function extractSearchContent(item: Record<string, unknown>, type: string): string {
  switch (type) {
    case 'agent_case':
      return (
        [item.key_insight, item.approach, item.task_intent]
          .map((v) => (typeof v === 'string' ? v : ''))
          .find((v) => v.length > 0) ?? ''
      );
    case 'episode':
      return (
        [item.summary, item.episode]
          .map((v) => (typeof v === 'string' ? v : ''))
          .find((v) => v.length > 0) ?? ''
      );
    case 'agent_skill':
      return (
        [item.description, item.name, item.content]
          .map((v) => (typeof v === 'string' ? v : ''))
          .find((v) => v.length > 0) ?? ''
      );
    case 'profile': {
      const profileData = item.profile_data;
      if (profileData && typeof profileData === 'object') {
        return JSON.stringify(profileData);
      }
      return '';
    }
    default:
      return '';
  }
}

function extractSource(item: Record<string, unknown>, type: string): string | undefined {
  switch (type) {
    case 'agent_case':
      return typeof item.task_intent === 'string' && item.task_intent.length > 0
        ? item.task_intent
        : undefined;
    case 'episode':
      return typeof item.subject === 'string' && item.subject.length > 0 ? item.subject : undefined;
    case 'agent_skill':
      return typeof item.name === 'string' && item.name.length > 0 ? item.name : undefined;
    default:
      return undefined;
  }
}
