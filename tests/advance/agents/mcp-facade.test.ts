// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { McpFacadeServer } from '../../../src/advance/agents/mcp-facade.js';

/**
 * MCP 门面端到端：真实起 127.0.0.1 服务 + MCP SSE client 调用。
 * scheduler 与 EverOS 均为 mock/缺省，验证门面协议与降级行为。
 */
describe('McpFacadeServer', () => {
  let facade: McpFacadeServer | null = null;

  afterEach(async () => {
    await facade?.stop();
    facade = null;
  });

  async function startFacade(overrides: {
    runs?: unknown[];
    submit?: ReturnType<typeof vi.fn>;
    everosUrl?: string | null;
  }) {
    facade = new McpFacadeServer({
      scheduler: {
        listPipelineRuns: () => overrides.runs ?? [],
        runProjectRoleNow: overrides.submit ?? vi.fn().mockResolvedValue(undefined),
      } as never,
      getEverosUrl: () => overrides.everosUrl ?? null,
    });
    const facadeUrl = await facade.start();
    // 门面 URL 自带 token：/sse 路径需保留查询串
    const base = new URL(facadeUrl);
    const sseUrl = `${base.origin}/sse${base.search}`;
    const client = new Client({ name: 'facade-test', version: '0.0.1' });
    await client.connect(new SSEClientTransport(new URL(sseUrl)));
    return client;
  }

  it('未带 token 的连接被拒绝', async () => {
    facade = new McpFacadeServer({
      scheduler: { listPipelineRuns: () => [], runProjectRoleNow: vi.fn() } as never,
      getEverosUrl: () => null,
    });
    const facadeUrl = await facade.start();
    const base = new URL(facadeUrl);
    const response = await fetch(`${base.origin}/sse`);
    expect(response.status).toBe(401);
  });

  it('列出工具清单', async () => {
    const client = await startFacade({});
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name).sort()).toEqual([
      'knowledge_recall',
      'pipeline_list_runs',
      'pipeline_submit',
    ]);
    await client.close();
  });

  it('pipeline_list_runs 返回运行记录', async () => {
    const client = await startFacade({
      runs: [{ id: 'r1', status: 'succeeded', stages: [] }],
    });
    const result = await client.callTool({
      name: 'pipeline_list_runs',
      arguments: { projectId: 'p1' },
    });
    const text = (result.content as Array<{ text?: string }>)[0].text ?? '';
    expect(JSON.parse(text)[0].id).toBe('r1');
    await client.close();
  });

  it('pipeline_submit 异步触发角色执行', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const client = await startFacade({ submit });
    const result = await client.callTool({
      name: 'pipeline_submit',
      arguments: { projectId: 'p1', role: 'reviewer' },
    });
    const text = (result.content as Array<{ text?: string }>)[0].text ?? '';
    expect(JSON.parse(text).submitted).toBe(true);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith('p1', 'reviewer'));
    await client.close();
  });

  it('pipeline_submit 拒绝未知角色', async () => {
    const client = await startFacade({});
    const result = await client.callTool({
      name: 'pipeline_submit',
      arguments: { projectId: 'p1', role: 'ghost' },
    });
    const text = (result.content as Array<{ text?: string }>)[0].text ?? '';
    expect(JSON.parse(text).error).toContain('未知角色');
    await client.close();
  });

  it('knowledge_recall 在 EverOS 未就绪时返回明确错误', async () => {
    const client = await startFacade({ everosUrl: null });
    const result = await client.callTool({
      name: 'knowledge_recall',
      arguments: { projectId: 'p1', query: '约定' },
    });
    const text = (result.content as Array<{ text?: string }>)[0].text ?? '';
    expect(JSON.parse(text).error).toContain('EverOS');
    await client.close();
  });
});
