import type {
  MemoryGraph,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphStats,
  Project,
} from '../../../electron/shared/types.js';
import type { EverOSMemoryGetResult } from './everos-api.js';

export interface BuildMemoryGraphInput {
  projects: Project[];
  getResults: Map<string, EverOSMemoryGetResult>;
}

export function buildMemoryGraph(input: BuildMemoryGraphInput): MemoryGraph {
  const nodes = new Map<string, MemoryGraphNode>();
  const edges = new Map<string, MemoryGraphEdge>();
  const userTopics = new Map<string, Set<string>>();
  const skillCases = new Map<string, Set<string>>();
  const systemSkills = new Set<string>();
  const profileProjects = new Map<string, Set<string>>();
  const projectUsers = new Map<string, Set<string>>();
  const caseProjects = new Map<string, string>();
  const projectNodeMap = new Map<string, string>();

  nodes.set('system', {
    id: 'system',
    label: 'CodeKeeper-System',
    group: 'system',
    title: 'CodeKeeper-System',
  });

  for (const project of input.projects) {
    const pid = `project:${project.id}`;
    nodes.set(pid, { id: pid, label: project.name, group: 'project', projectId: project.id });
    addEdge(edges, 'system', pid, 'contains');
    projectNodeMap.set(project.id, pid);
    projectUsers.set(project.id, new Set());
  }

  // 先收集 case -> project 映射
  for (const [projectId, result] of input.getResults) {
    for (const item of result.agent_cases ?? []) {
      if (typeof item.id === 'string') caseProjects.set(item.id, projectId);
    }
  }

  // 第一遍：episodes / agent_cases
  for (const [projectId, result] of input.getResults) {
    const projectNodeId = projectNodeMap.get(projectId);
    if (!projectNodeId) continue;
    for (const item of result.episodes ?? []) {
      processEntry(item, 'episode', projectId, projectNodeId, nodes, edges, userTopics, projectUsers);
    }
    for (const item of result.agent_cases ?? []) {
      processEntry(item, 'agent_case', projectId, projectNodeId, nodes, edges, userTopics, projectUsers);
    }
  }

  // 第二遍：skills / profiles
  for (const [projectId, result] of input.getResults) {
    const projectNodeId = projectNodeMap.get(projectId);
    if (!projectNodeId) continue;
    for (const item of result.agent_skills ?? []) {
      processSkill(item, projectId, projectNodeId, nodes, edges, caseProjects, skillCases, systemSkills);
    }
    for (const item of result.profiles ?? []) {
      processProfile(item, projectId, projectNodeId, nodes, edges, profileProjects);
    }
  }

  // profile 跨项目判定后，迁移到 system 下
  for (const [userId, projectSet] of profileProjects) {
    const profileNodeId = `profile:${userId}`;
    const node = nodes.get(profileNodeId);
    if (!node) continue;
    if (projectSet.size >= 2) {
      node.projectId = undefined;
      addEdge(edges, 'system', profileNodeId, 'shared');
      for (const pid of projectSet) {
        const projectUserSet = projectUsers.get(pid);
        if (projectUserSet) projectUserSet.add(userId);
      }
    }
    const userNodeId = `user:${userId}`;
    addEdge(edges, userNodeId, profileNodeId, 'has_profile');
  }

  addCrossTopicEdges(userTopics, edges);
  addRelatedSkillEdges(skillCases, edges);
  addProjectShareEdges(projectUsers, edges);

  const nodeList = [...nodes.values()];
  const edgeList = [...edges.values()];
  return {
    nodes: nodeList,
    edges: edgeList,
    stats: buildStats(nodeList, edgeList, input.getResults),
  };
}

function addEdge(
  edges: Map<string, MemoryGraphEdge>,
  from: string,
  to: string,
  label?: string
): void {
  const id = `${from}--${to}`;
  if (edges.has(id)) return;
  const edge: MemoryGraphEdge = { id, from, to };
  if (label) edge.label = label;
  edges.set(id, edge);
}

export function parseTopicId(sessionId: string): { topicId: string; label: string } | null {
  const mrMatch = sessionId.match(/(?:reviewer|maintainer)-(.+?)-mr-(\d+)$/);
  if (mrMatch) {
    return { topicId: `mr:${mrMatch[2]}`, label: `MR !${mrMatch[2]}` };
  }
  const discussionMatch = sessionId.match(/(?:discussion|interaction)-([^-]+)$/);
  if (discussionMatch) {
    return { topicId: `discussion:${discussionMatch[1]}`, label: `Discussion #${discussionMatch[1]}` };
  }
  const archiveMatch = sessionId.match(/archiver-(.+?)-(\d{4}-\d{2}-\d{2})-(\d)$/);
  if (archiveMatch) {
    return { topicId: `archive:${archiveMatch[2]}-${archiveMatch[3]}`, label: `${archiveMatch[2]}-${archiveMatch[3]}` };
  }
  return null;
}

function processEntry(
  item: Record<string, unknown>,
  group: 'episode' | 'agent_case',
  projectId: string,
  projectNodeId: string,
  nodes: Map<string, MemoryGraphNode>,
  edges: Map<string, MemoryGraphEdge>,
  userTopics: Map<string, Set<string>>,
  projectUsers: Map<string, Set<string>>
): void {
  const rawId = typeof item.id === 'string' ? item.id : `${group}-${cryptoRandomId()}`;
  const sessionId = typeof item.session_id === 'string' ? item.session_id : '';
  const parsed = parseTopicId(sessionId);
  const topicId = parsed ? `topic:${parsed.topicId}` : 'topic:unknown';

  if (!nodes.has(topicId)) {
    nodes.set(topicId, {
      id: topicId,
      label: parsed?.label ?? '未知话题',
      group: 'topic',
      projectId,
    });
  }
  addEdge(edges, projectNodeId, topicId, 'contains');

  const nodeId = `${group}:${rawId}`;
  const label =
    group === 'episode'
      ? truncate(String(item.summary ?? item.subject ?? rawId), 80)
      : truncate(String(item.key_insight ?? item.task_intent ?? rawId), 80);
  nodes.set(nodeId, {
    id: nodeId,
    label,
    group,
    title: typeof item.subject === 'string' ? item.subject : undefined,
    details:
      typeof item.episode === 'string'
        ? item.episode
        : typeof item.approach === 'string'
          ? item.approach
          : undefined,
    timestamp: typeof item.timestamp === 'string' ? item.timestamp : undefined,
    projectId,
  });
  addEdge(edges, topicId, nodeId, 'contains');

  const ownerList =
    group === 'episode'
      ? ([item.user_id, ...((item.sender_ids as string[]) ?? [])].filter(Boolean) as string[])
      : [item.agent_id as string];
  for (const ownerId of ownerList) {
    if (!ownerId) continue;
    const ownerGroup = group === 'episode' ? 'user' : 'agent';
    const ownerNodeId = `${ownerGroup}:${ownerId}`;
    if (!nodes.has(ownerNodeId)) {
      nodes.set(ownerNodeId, { id: ownerNodeId, label: ownerId, group: ownerGroup });
    }
    addEdge(edges, ownerNodeId, nodeId, 'authored');
    if (ownerGroup === 'user') {
      const projectUserSet = projectUsers.get(projectId);
      if (projectUserSet) projectUserSet.add(ownerId);
    }
    if (!userTopics.has(ownerNodeId)) userTopics.set(ownerNodeId, new Set());
    userTopics.get(ownerNodeId)!.add(topicId);
  }
}

function processSkill(
  item: Record<string, unknown>,
  projectId: string,
  projectNodeId: string,
  nodes: Map<string, MemoryGraphNode>,
  edges: Map<string, MemoryGraphEdge>,
  caseProjects: Map<string, string>,
  skillCases: Map<string, Set<string>>,
  systemSkills: Set<string>
): void {
  const rawId = typeof item.id === 'string' ? item.id : `skill-${cryptoRandomId()}`;
  const skillNodeId = `agent_skill:${rawId}`;
  const sourceCaseIds = ((item.source_case_ids as string[]) ?? []).filter((id): id is string => typeof id === 'string');
  const sourceProjects = new Set(sourceCaseIds.map((id) => caseProjects.get(id)).filter((p): p is string => !!p));
  const isSystem = sourceProjects.size >= 2;
  const parentId = isSystem ? 'system' : projectNodeId;

  nodes.set(skillNodeId, {
    id: skillNodeId,
    label: truncate(String(item.name ?? rawId), 80),
    group: 'agent_skill',
    projectId: isSystem ? undefined : projectId,
  });
  addEdge(edges, parentId, skillNodeId, isSystem ? 'shared' : 'contains');
  skillCases.set(skillNodeId, new Set(sourceCaseIds));
  if (isSystem) systemSkills.add(skillNodeId);

  for (const caseId of sourceCaseIds) {
    addEdge(edges, skillNodeId, `agent_case:${caseId}`, 'derived_from');
  }

  const agentId = String(item.agent_id ?? '');
  if (agentId) {
    const agentNodeId = `agent:${agentId}`;
    if (!nodes.has(agentNodeId)) {
      nodes.set(agentNodeId, { id: agentNodeId, label: agentId, group: 'agent' });
    }
    addEdge(edges, agentNodeId, skillNodeId, 'authored');
  }
}

function processProfile(
  item: Record<string, unknown>,
  projectId: string,
  projectNodeId: string,
  nodes: Map<string, MemoryGraphNode>,
  edges: Map<string, MemoryGraphEdge>,
  profileProjects: Map<string, Set<string>>
): void {
  const userId = String(item.user_id ?? '');
  if (!userId) return;
  const profileNodeId = `profile:${userId}`;
  if (!nodes.has(profileNodeId)) {
    nodes.set(profileNodeId, {
      id: profileNodeId,
      label: userId,
      group: 'profile',
      projectId,
    });
    addEdge(edges, projectNodeId, profileNodeId, 'contains');
  }
  if (!profileProjects.has(userId)) profileProjects.set(userId, new Set());
  profileProjects.get(userId)!.add(projectId);

  const userNodeId = `user:${userId}`;
  if (!nodes.has(userNodeId)) {
    nodes.set(userNodeId, { id: userNodeId, label: userId, group: 'user' });
  }
}

function addCrossTopicEdges(
  userTopics: Map<string, Set<string>>,
  edges: Map<string, MemoryGraphEdge>
): void {
  for (const topicSet of userTopics.values()) {
    const topics = [...topicSet];
    for (let i = 0; i < topics.length; i++) {
      for (let j = i + 1; j < topics.length; j++) {
        addEdge(edges, topics[i], topics[j], 'same_author');
      }
    }
  }
}

function addRelatedSkillEdges(
  skillCases: Map<string, Set<string>>,
  edges: Map<string, MemoryGraphEdge>
): void {
  const skills = [...skillCases.entries()];
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const [idA, casesA] = skills[i];
      const [idB, casesB] = skills[j];
      const overlap = [...casesA].some((id) => casesB.has(id));
      if (overlap) {
        addEdge(edges, idA, idB, 'related_skill');
      }
    }
  }
}

function addProjectShareEdges(
  projectUsers: Map<string, Set<string>>,
  edges: Map<string, MemoryGraphEdge>
): void {
  const projectIds = [...projectUsers.keys()];
  for (let i = 0; i < projectIds.length; i++) {
    for (let j = i + 1; j < projectIds.length; j++) {
      const pidA = projectIds[i];
      const pidB = projectIds[j];
      const usersA = projectUsers.get(pidA) ?? new Set();
      const usersB = projectUsers.get(pidB) ?? new Set();
      const sharedUser = [...usersA].some((u) => usersB.has(u));
      if (sharedUser) {
        addEdge(edges, `project:${pidA}`, `project:${pidB}`, 'shares');
      }
    }
  }
}

function buildStats(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  getResults: Map<string, EverOSMemoryGetResult>
): MemoryGraphStats {
  const memoryGroups = ['episode', 'agent_case', 'agent_skill', 'profile'] as const;
  let totalMemories = 0;
  for (const node of nodes) {
    if (memoryGroups.includes(node.group as any)) totalMemories++;
  }
  const dailyMap = new Map<string, number>();
  for (const result of getResults.values()) {
    for (const item of [...result.episodes, ...result.agent_cases]) {
      const ts = typeof item.timestamp === 'string' ? item.timestamp : '';
      const date = ts.slice(0, 10);
      if (date) dailyMap.set(date, (dailyMap.get(date) ?? 0) + 1);
    }
  }
  const dailyGrowth = [...dailyMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-14)
    .map(([date, count]) => ({ date, count }));

  return {
    totalNodes: nodes.length,
    totalEdges: edges.length,
    totalMemories,
    projectCount: nodes.filter((n) => n.group === 'project').length,
    activeDays: dailyMap.size,
    dailyGrowth,
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function cryptoRandomId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
