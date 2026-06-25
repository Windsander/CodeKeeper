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
