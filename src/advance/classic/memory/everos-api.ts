import { sanitizeEverOSId } from './types.js';

/**
 * EverOS /api/v1/memory/add 单条消息封装
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
 * 批量写入时的单条消息（支持自定义时间戳，用于回放远端历史评论）
 */
export interface EverOSAddMessage {
  senderId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp?: number;
}

/**
 * 向 EverOS 写入一条记忆消息
 */
export async function everosMemoryAdd(everosUrl: string, params: EverOSAddParams): Promise<void> {
  await everosMemoryAddMessages(everosUrl, params, [
    { senderId: params.senderId, role: params.role, content: params.content },
  ]);
}

/**
 * 向 EverOS 批量写入同一 session 的多条记忆消息
 */
export async function everosMemoryAddMessages(
  everosUrl: string,
  params: Pick<EverOSAddParams, 'appId' | 'projectId' | 'sessionId'>,
  messages: EverOSAddMessage[]
): Promise<void> {
  const body = {
    app_id: sanitizeEverOSId(params.appId),
    project_id: sanitizeEverOSId(params.projectId),
    session_id: sanitizeEverOSId(params.sessionId),
    messages: messages.map((m) => ({
      sender_id: sanitizeEverOSId(m.senderId),
      role: m.role,
      timestamp: m.timestamp ?? Date.now(),
      content: m.content,
    })),
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

interface SearchAgentCaseItem {
  id?: string;
  agent_id?: string;
  app_id?: string;
  project_id?: string;
  session_id?: string;
  task_intent?: string;
  approach?: string;
  key_insight?: string | null;
  quality_score?: number;
  timestamp?: string;
  score?: number;
}

interface SearchEpisodeItem {
  id?: string;
  user_id?: string;
  app_id?: string;
  project_id?: string;
  session_id?: string;
  summary?: string;
  subject?: string;
  episode?: string;
  timestamp?: string;
  score?: number;
}

interface SearchAgentSkillItem {
  id?: string;
  agent_id?: string;
  app_id?: string;
  project_id?: string;
  name?: string;
  description?: string;
  content?: string;
  confidence?: number;
  maturity_score?: number;
  score?: number;
}

interface SearchProfileItem {
  id?: string;
  user_id?: string;
  app_id?: string;
  project_id?: string;
  profile_data?: Record<string, string | number | boolean | null>;
}

interface EverOSSearchResponse {
  agent_cases?: SearchAgentCaseItem[];
  episodes?: SearchEpisodeItem[];
  agent_skills?: SearchAgentSkillItem[];
  profiles?: SearchProfileItem[];
}

/**
 * 强制刷新指定 session 的记忆边界，使已累积的 message 立即进入提取流水线
 */
export async function everosMemoryFlush(
  everosUrl: string,
  params: Pick<EverOSAddParams, 'appId' | 'projectId' | 'sessionId'>
): Promise<void> {
  const body = {
    app_id: sanitizeEverOSId(params.appId),
    project_id: sanitizeEverOSId(params.projectId),
    session_id: sanitizeEverOSId(params.sessionId),
  };

  const res = await fetch(`${everosUrl}/api/v1/memory/flush`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`EverOS memory/flush 失败: ${res.status} ${await res.text()}`);
  }
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
  const body: Record<string, string | number | boolean> = {
    app_id: sanitizeEverOSId(params.appId),
    project_id: sanitizeEverOSId(params.projectId),
    query: params.query,
    top_k: params.topK ?? 5,
    method: 'hybrid',
    enable_llm_rerank: true,
  };

  if (params.owner.kind === 'user') {
    body.user_id = sanitizeEverOSId(params.owner.userId);
    body.include_profile = true;
  } else {
    body.agent_id = sanitizeEverOSId(params.owner.agentId);
  }

  const res = await fetch(`${everosUrl}/api/v1/memory/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`EverOS memory/search 失败: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { data?: EverOSSearchResponse };
  const data = json.data ?? {};
  const items: EverOSSearchItem[] = [];

  for (const agentCase of data.agent_cases ?? []) {
    const content = agentCase.key_insight ?? agentCase.approach ?? agentCase.task_intent ?? '';
    if (!content) continue;
    items.push({
      id: agentCase.id ?? `agent_case-${items.length}`,
      type: 'agent_case',
      content,
      source: agentCase.task_intent,
      timestamp: agentCase.timestamp,
      score: agentCase.score,
      sessionId: agentCase.session_id,
    });
  }

  for (const episode of data.episodes ?? []) {
    const content = episode.summary ?? episode.episode ?? '';
    if (!content) continue;
    items.push({
      id: episode.id ?? `episode-${items.length}`,
      type: 'episode',
      content,
      source: episode.subject,
      timestamp: episode.timestamp,
      score: episode.score,
      sessionId: episode.session_id,
    });
  }

  for (const skill of data.agent_skills ?? []) {
    const content = skill.description ?? skill.name ?? skill.content ?? '';
    if (!content) continue;
    items.push({
      id: skill.id ?? `agent_skill-${items.length}`,
      type: 'agent_skill',
      content,
      source: skill.name,
      timestamp: undefined,
      score: skill.score,
      sessionId: undefined,
    });
  }

  for (const profile of data.profiles ?? []) {
    const profileData = profile.profile_data;
    if (!profileData) continue;
    items.push({
      id: profile.id ?? `profile-${items.length}`,
      type: 'profile',
      content: JSON.stringify(profileData),
      source: undefined,
      timestamp: undefined,
      score: undefined,
      sessionId: undefined,
    });
  }

  items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return { items };
}

/**
 * EverOS /api/v1/memory/get 请求参数
 */
export interface EverOSMemoryGetParams {
  everosUrl: string;
  appId: string;
  projectId: string;
  ownerKind: 'user' | 'agent';
  ownerId: string;
  memoryType: 'episode' | 'profile' | 'agent_case' | 'agent_skill';
  page?: number;
  pageSize?: number;
}

/**
 * EverOS /api/v1/memory/get 响应抽象
 */
export interface EverOSMemoryGetResult {
  episodes: Array<Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
  agent_cases: Array<Record<string, unknown>>;
  agent_skills: Array<Record<string, unknown>>;
  total_count: number;
}

/**
 * 从 EverOS 拉取指定 owner 与类型的记忆条目
 */
export async function everosMemoryGet(
  params: EverOSMemoryGetParams
): Promise<EverOSMemoryGetResult> {
  const body: Record<string, string | number> = {
    app_id: sanitizeEverOSId(params.appId),
    project_id: sanitizeEverOSId(params.projectId),
    memory_type: params.memoryType,
    page: params.page ?? 1,
    page_size: params.pageSize ?? 100,
  };

  if (params.ownerKind === 'user') {
    body.user_id = sanitizeEverOSId(params.ownerId);
  } else {
    body.agent_id = sanitizeEverOSId(params.ownerId);
  }

  const res = await fetch(`${params.everosUrl}/api/v1/memory/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`EverOS memory/get 失败: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { data?: EverOSMemoryGetResult };
  return {
    episodes: json.data?.episodes ?? [],
    profiles: json.data?.profiles ?? [],
    agent_cases: json.data?.agent_cases ?? [],
    agent_skills: json.data?.agent_skills ?? [],
    total_count: json.data?.total_count ?? 0,
  };
}

/**
 * 从 /get 结果中收集出现过的 user_id 与 agent_id
 */
export function extractOwnersFromGetResult(result: EverOSMemoryGetResult): {
  users: Set<string>;
  agents: Set<string>;
} {
  const users = new Set<string>();
  const agents = new Set<string>();

  for (const item of result.episodes ?? []) {
    if (typeof item.user_id === 'string') users.add(item.user_id);
    for (const sid of (item.sender_ids as unknown[]) ?? []) {
      users.add(String(sid));
    }
  }
  for (const item of result.profiles ?? []) {
    if (typeof item.user_id === 'string') users.add(item.user_id);
  }
  for (const item of result.agent_cases ?? []) {
    if (typeof item.agent_id === 'string') agents.add(item.agent_id);
  }
  for (const item of result.agent_skills ?? []) {
    if (typeof item.agent_id === 'string') agents.add(item.agent_id);
  }

  return { users, agents };
}
