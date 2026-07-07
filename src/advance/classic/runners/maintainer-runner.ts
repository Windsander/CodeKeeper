/**
 * Maintainer 角色的 Runner 实现
 *
 * 负责：读取 MR 下所有 Reviewer/人工创建的 discussion，协调 MaintainerBrain 做决策、
 * MaintainerActor 执行修复或回复，并通过评论与 Reviewer 交互。
 * 不主动发现新问题，也不发布 review summary。
 */

import { LlmClient } from '../../llm/client.js';
import { GitLabProvider } from '../provider/gitlab-provider.js';
import { WorktreeManager } from '../worktree/worktree-manager.js';
import { MrFixAgent } from '../fix/mr-fix-agent.js';
import { MaintainerBrain } from '../fix/maintainer-brain.js';
import { MaintainerActor } from '../fix/maintainer-actor.js';
import { MemoryClient } from '../memory/memory-client.js';
import { RecallPlanner } from '../memory/recall-planner.js';
import type { Project, RoleConfig, MaintainerConfig } from '../../types.js';
import type { MergeRequest, ReviewFinding, Discussion } from '../provider/types.js';
import { buildAuthenticatedRemoteUrl } from './shared/config-utils.js';
import { loadState, saveState, type MrAgentState } from './shared/state-utils.js';
import { formatAgentFooter, isMaintainerAuthoredNote, MAINTAINER_ROLE_LABEL } from './shared/review-utils.js';
import { readDiscussionFileContent } from './shared/discussion-file-reader.js';
import { BaseRoleRunner } from './base-role-runner.js';

/**
 * 构建 Maintainer 修复尝试会话 ID（按 MR 粒度）
 */
export function buildMaintainerMrSessionId(projectId: string, mrIid: number): string {
  return `maintainer-${projectId}-mr-${mrIid}`;
}

/**
 * MaintainerRunner 构造选项
 */
export interface MaintainerRunnerOptions {
  /** LLM 客户端实例 */
  llmClient: LlmClient;
}

export class MaintainerRunner extends BaseRoleRunner {
  constructor(options: MaintainerRunnerOptions) {
    super({ llmClient: options.llmClient });
  }

  protected getRole(): 'maintainer' {
    return 'maintainer';
  }

  protected getDefaultSchedule(): string {
    return '*/10 * * * *';
  }

  /**
   * 对单个项目执行 MR 维护轮询
   */
  protected async runProject(project: Project, config: RoleConfig): Promise<void> {
    const maintainerConfig = config as MaintainerConfig;
    const gitlabConfig = project.gitlab!;

    const provider = new GitLabProvider(gitlabConfig);

    const { soul, projectContext } = this.loadRoleContext(project);

    const mcpUrl = process.env.CK_EVEROS_MCP_URL ?? '';
    const baseMemoryContext = {
      appId: 'codekeeper-advance',
      projectId: project.id,
      agentId: 'maintainer',
      userId: 'codekeeper-system',
    };

    const allowedRiskLevels = maintainerConfig.autoFixRiskLevels ?? ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    const maintainerName = maintainerConfig.maintainerName || 'CodeKeeper Maintainer';
    const worktreeManager = new WorktreeManager({
      projectId: project.id,
      rootPath: project.rootPath,
      remoteUrl: buildAuthenticatedRemoteUrl(gitlabConfig),
    });
    const fixAgent = new MrFixAgent({ worktreeManager, llmClient: this.llmClient });
    const actor = new MaintainerActor({ provider, fixAgent, maintainerName });

    const brainOptions = {
      llmClient: this.llmClient,
      allowedRiskLevels,
      soulContent: soul.content || undefined,
      projectContext,
    };

    const state = loadState(project);
    state.interactiveThreads ??= {};

    console.log(`[MaintainerRunner] 扫描项目 ${project.name} 的 open MRs...`);
    console.log(`[MaintainerRunner] 项目 ${project.name} 使用 filter: ${JSON.stringify(maintainerConfig.filter ?? {})}`);
    console.log(`[MaintainerRunner] 项目 ${project.name} 允许自动修复的风险等级: ${allowedRiskLevels.join(',')}`);

    let mrs: MergeRequest[];
    try {
      mrs = await provider.listOpenMRs(config.filter);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[MaintainerRunner] 列出项目 ${project.name} 的 MR 失败: ${message}`);
      throw error;
    }

    console.log(`[MaintainerRunner] 项目 ${project.name} 发现 ${mrs.length} 个 open MR`);

    // 默认跳过 draft；如果 filter 里显式配置了 Draft=true，则保留 draft MR
    const draftCondition = maintainerConfig.filter?.conditions.find((c) => c.field === 'draft');
    const includeDraft = draftCondition?.values.includes('true') ?? false;

    for (const mr of mrs) {
      if (mr.draft && !includeDraft) {
        console.log(`[MaintainerRunner] 跳过 draft MR !${mr.iid}: ${mr.title}`);
        continue;
      }

      console.log(`[MaintainerRunner] 维护 MR !${mr.iid}: ${mr.title}`);

      let discussions: Discussion[];
      try {
        discussions = await provider.getDiscussions(mr.iid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MaintainerRunner] 获取 MR !${mr.iid} discussions 失败: ${message}`);
        continue;
      }

      const memoryClient = mcpUrl
        ? new MemoryClient({
            mcpUrl,
            context: {
              ...baseMemoryContext,
              sessionId: buildMaintainerMrSessionId(project.id, mr.iid),
            },
          })
        : undefined;
      await memoryClient?.connect().catch(() => undefined);
      const recallPlanner = memoryClient
        ? new RecallPlanner({ llmClient: this.llmClient, memoryClient })
        : undefined;
      const brain = new MaintainerBrain({ ...brainOptions, memoryClient, recallPlanner });

      console.log(`[MaintainerRunner] MR !${mr.iid} 原始 discussion 数量: ${discussions.length}`);
      discussions.forEach((d, idx) => {
        console.log(
          `[MaintainerRunner] discussion[${idx}] id=${d.id}, resolvable=${d.resolvable}, resolved=${d.resolved}, notes=${d.notes.length}, firstAuthor=${d.notes[0]?.author ?? 'none'}`
        );
      });

      const pendingDiscussions = discussions.filter((d) => {
        if (d.resolved || !d.resolvable) return false;

        const hasMaintainerNote = d.notes.some((note) => isMaintainerAuthoredNote(note.body));
        const isInteractive = state.interactiveThreads[d.id]?.status === 'awaiting-reply';
        // 如果已处理过且没有新 note，且非交互式，跳过
        const processed = state.processedDiscussions?.[d.id];
        const hasNewNotes = processed ? d.notes.length > processed.noteCount : true;
        if (processed && !hasNewNotes && !isInteractive) return false;
        // 如果 Maintainer 已经处理过且不在交互等待中，跳过（避免重复回复）
        if (hasMaintainerNote && !isInteractive) return false;
        return true;
      });

      console.log(`[MaintainerRunner] MR !${mr.iid} 过滤后待处理 discussion 数量: ${pendingDiscussions.length}`);

      if (pendingDiscussions.length === 0) {
        console.log(`[MaintainerRunner] MR !${mr.iid} 没有待处理的 discussion，跳过`);
        await memoryClient?.disconnect().catch(() => undefined);
        continue;
      }

      console.log(`[MaintainerRunner] MR !${mr.iid} 有 ${pendingDiscussions.length} 个待处理 discussion`);
      for (const discussion of pendingDiscussions) {
        await this.processDiscussion(
          mr,
          discussion,
          provider,
          brain,
          actor,
          fixAgent,
          worktreeManager,
          maintainerName,
          state,
          project.rootPath
        );
      }
      await memoryClient?.disconnect().catch(() => undefined);
    }

    saveState(project, state);
  }

  /**
   * 处理单个 discussion（来自 Reviewer 或人工）
   */
  private async processDiscussion(
    mr: MergeRequest,
    discussion: Discussion,
    provider: GitLabProvider,
    brain: MaintainerBrain,
    actor: MaintainerActor,
    fixAgent: MrFixAgent,
    worktreeManager: WorktreeManager,
    maintainerName: string,
    state: MrAgentState,
    projectRootPath: string
  ): Promise<void> {
    const recordProcessed = () => {
      state.processedDiscussions ??= {};
      state.processedDiscussions[discussion.id] = { noteCount: discussion.notes.length, processedAt: Date.now() };
    };

    const firstNote = discussion.notes[0];
    if (!firstNote) {
      recordProcessed();
      return;
    }

    // 如果本 discussion 正在交互式等待 Reviewer 回复，先处理新回复
    const existingThread = state.interactiveThreads?.[discussion.id];
    if (existingThread?.status === 'awaiting-reply') {
      const askedAt = existingThread.askedAt;
      const newReviewerNotes = discussion.notes.filter((note) => {
        if (isMaintainerAuthoredNote(note.body)) return false;
        const noteTime = new Date(note.createdAt).getTime();
        return !Number.isNaN(noteTime) && noteTime > askedAt;
      });

      if (newReviewerNotes.length === 0) {
        console.log(`[MaintainerRunner] discussion ${discussion.id} 等待 Reviewer 回复中`);
        recordProcessed();
        return;
      }

      await this.handleInteractiveReply(
        mr,
        discussion,
        brain,
        actor,
        worktreeManager,
        maintainerName,
        state,
        projectRootPath
      );
      recordProcessed();
      return;
    }

    // 解析 finding
    let findings = await brain.parseFindings({
      body: firstNote.body,
      position: discussion.position,
      isSummary: firstNote.body.includes('CodeKeeper Advance MR 评审 Agent'),
    });

    // 无法从 body 解析时，若 position 提供了文件路径，则构造一个 synthetic finding
    if (findings.length === 0) {
      const fallbackFile = discussion.position?.newPath ?? discussion.position?.oldPath;
      if (fallbackFile) {
        console.log(
          `[MaintainerRunner] discussion ${discussion.id} 无法从 body 解析 finding，使用 position 兜底`
        );
        findings = [
          {
            severity: 'MEDIUM',
            file: fallbackFile,
            line: discussion.position?.newLine ?? discussion.position?.oldLine ?? 1,
            message: firstNote.body,
            suggestion: firstNote.body,
            autoFixable: false,
          },
        ];
      } else {
        console.warn(`[MaintainerRunner] 无法从 discussion ${discussion.id} 解析 finding`);
        try {
          await provider.addDiscussionNote(
            mr.iid,
            discussion.id,
            `👋 ${maintainerName} 无法自动解析该 discussion，需要人工处理。\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, maintainerName)}`
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[MaintainerRunner] 回复 discussion ${discussion.id} 失败: ${message}`);
        }
        recordProcessed();
        return;
      }
    }

    if (findings.length > 0) {
      findings = await brain.enrichFindingsWithCases(findings, mr.iid);
    }

    console.log(
      `[MaintainerRunner] 从 discussion ${discussion.id} 解析到 ${findings.length} 个 finding`
    );

    // 单条 finding：直接交给 Actor 执行决策后的动作
    if (findings.length === 1) {
      const finding = findings[0];
      const fileContent = await readDiscussionFileContent(
        worktreeManager,
        projectRootPath,
        finding.file,
        mr.sourceBranch
      );
      if (fileContent === null) {
        console.warn(`[MaintainerRunner] 读取文件 ${finding.file} 失败，跳过`);
        recordProcessed();
        return;
      }

      const decision = await brain.decide({
        finding,
        fileContent,
        originalComment: firstNote.body,
        mrIid: mr.iid,
        userId: firstNote.author,
      });
      console.log(
        `[MaintainerRunner] finding ${finding.file}:${finding.line} 决策: action=${decision.action}, reason=${decision.reason}`
      );

      await actor.applyDecision(mr, discussion, finding, decision, state);
      recordProcessed();
      return;
    }

    // 多条 finding：逐个决策并执行修复，最后统一汇总回复
    const fixedItems: string[] = [];
    const failedItems: string[] = [];
    const askedItems: Array<{ fileLine: string; text: string }> = [];
    const ignoredItems: Array<{ fileLine: string; reason: string }> = [];

    for (const finding of findings) {
      const fileContent = await readDiscussionFileContent(
        worktreeManager,
        projectRootPath,
        finding.file,
        mr.sourceBranch
      );
      if (fileContent === null) {
        failedItems.push(`${finding.file}:${finding.line} — 读取文件失败`);
        continue;
      }

      const decision = await brain.decide({
        finding,
        fileContent,
        originalComment: firstNote.body,
        mrIid: mr.iid,
        userId: firstNote.author,
      });
      console.log(
        `[MaintainerRunner] finding ${finding.file}:${finding.line} 决策: action=${decision.action}, reason=${decision.reason}`
      );

      if (decision.action === 'ignore') {
        ignoredItems.push({ fileLine: `${finding.file}:${finding.line}`, reason: decision.reason });
        continue;
      }

      if (decision.action === 'ask') {
        askedItems.push({
          fileLine: `${finding.file}:${finding.line}`,
          text: decision.question ?? decision.reason,
        });
        continue;
      }

      const fixResult = await fixAgent.executeFix(finding, mr, { scope: decision.scope });
      console.log(
        `[MaintainerRunner] finding ${finding.file}:${finding.line} 修复结果: success=${fixResult.success}, reason=${fixResult.reason}`
      );
      if (fixResult.success) {
        fixedItems.push(`${finding.file}:${finding.line}`);
      } else {
        failedItems.push(`${finding.file}:${finding.line} — ${fixResult.reason}`);
      }
    }

    await actor.postSummary(
      mr,
      discussion,
      fixedItems,
      failedItems,
      askedItems,
      ignoredItems,
      state
    );
    recordProcessed();
  }

  /**
   * 处理交互式 discussion 中 Reviewer 的新回复
   */
  private async handleInteractiveReply(
    mr: MergeRequest,
    discussion: Discussion,
    brain: MaintainerBrain,
    actor: MaintainerActor,
    worktreeManager: WorktreeManager,
    maintainerName: string,
    state: MrAgentState,
    projectRootPath: string
  ): Promise<void> {
    const thread = state.interactiveThreads[discussion.id];
    const filePath = thread?.filePath;
    if (!filePath) {
      console.warn(`[MaintainerRunner] interactive thread ${discussion.id} 缺少 filePath，移除状态`);
      delete state.interactiveThreads[discussion.id];
      return;
    }

    const fileContent = await readDiscussionFileContent(
      worktreeManager,
      projectRootPath,
      filePath,
      mr.sourceBranch
    );
    if (fileContent === null) {
      console.warn(`[MaintainerRunner] 读取文件 ${filePath} 失败，跳过交互回复处理`);
      return;
    }

    const threadNotes = discussion.notes.map((note) => ({
      author: note.author,
      body: note.body,
      createdAt: note.createdAt,
    }));

    console.log(`[MaintainerRunner] discussion ${discussion.id} 收到 Reviewer 回复，请求 LLM 决策`);
    const decision = await brain.decideReply({
      filePath,
      fileContent,
      threadNotes,
      maintainerName,
    });
    console.log(`[MaintainerRunner] LLM 决策: action=${decision.action}`);

    const syntheticFinding: ReviewFinding = {
      severity: 'MEDIUM',
      file: filePath,
      line: 1,
      message: decision.fixDescription ?? '根据 Reviewer 回复处理',
      suggestion: decision.fixDescription ?? '根据 Reviewer 回复处理',
      autoFixable: true,
    };

    await actor.applyDecision(mr, discussion, syntheticFinding, decision, state);
  }
}
