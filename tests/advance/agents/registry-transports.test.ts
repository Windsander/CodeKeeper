import { describe, expect, it, vi } from 'vitest';
import { AgentRegistry, agentSpecSchema } from '../../../src/advance/agents/registry.js';
import { A2aTransport } from '../../../src/advance/agents/transports.js';
import type { TaskEnvelope } from '../../../src/advance/agents/task-envelope.js';

const baseEnvelope: TaskEnvelope = {
  id: 'run-1:node-1',
  capability: 'echo',
  input: { value: 41 },
  artifacts: [],
};

describe('AgentRegistry', () => {
  it('注册表解析：agentId 引用 + 内联参数合并', () => {
    const registry = new AgentRegistry([
      {
        id: 'local-echo',
        name: '本地回显',
        transport: 'subprocess',
        command: 'node',
        args: ['-e', 'console.log("x")'],
        capabilities: ['echo'],
      },
    ]);
    const transport = registry.resolveTransport('agent.subprocess', { agentId: 'local-echo' });
    expect(transport.kind).toBe('subprocess');
  });

  it('未注册 agentId 抛错', () => {
    const registry = new AgentRegistry([]);
    expect(() => registry.resolveTransport('agent.a2a', { agentId: 'ghost' })).toThrow(/未注册/);
  });

  it('内联参数可构造一次性网络类传输（a2a 无需注册）', () => {
    const registry = new AgentRegistry([]);
    const transport = registry.resolveTransport('agent.a2a', {
      endpoint: 'http://agent.example.invalid',
    });
    expect(transport.kind).toBe('a2a');
  });

  it('subprocess 强制要求已注册 agentId（命令只允许本机白名单）', () => {
    const registry = new AgentRegistry([]);
    expect(() => registry.resolveTransport('agent.subprocess', { command: 'sh' })).toThrow(
      /agentId/
    );
  });

  it('agentId 引用时注册项优先于内联 params（防止 pipeline.yaml 投毒）', () => {
    const registry = new AgentRegistry([
      {
        id: 'trusted',
        name: '可信',
        transport: 'subprocess',
        command: 'node',
        capabilities: [],
      },
    ]);
    const transport = registry.resolveTransport('agent.subprocess', {
      agentId: 'trusted',
      command: 'evil-cmd',
    });
    expect(transport.kind).toBe('subprocess');
    // spec 覆盖 params：command 仍是注册项的 node
    expect((transport as unknown as { spec: { command: string } }).spec.command).toBe('node');
  });

  it('缺少连接参数时报错信息含字段名', () => {
    const registry = new AgentRegistry([
      { id: 'no-cmd', name: 'x', transport: 'subprocess', command: '', capabilities: [] },
    ]);
    expect(() => registry.resolveTransport('agent.subprocess', { agentId: 'no-cmd' })).toThrow(
      /command/
    );
    expect(() => registry.resolveTransport('agent.mcp', {})).toThrow(/serverUrl/);
  });

  it('spec schema 校验非法 transport', () => {
    expect(() => agentSpecSchema.parse({ id: 'x', name: 'x', transport: 'pigeon' })).toThrow();
  });

  it('subprocess probe：node 可执行返回 true', async () => {
    const registry = new AgentRegistry([
      { id: 'n', name: 'n', transport: 'subprocess', command: process.execPath, args: [] },
    ]);
    const results = await registry.probeAll();
    expect(results).toEqual([{ id: 'n', ok: true }]);
  });
});

describe('SubprocessTransport', () => {
  it('stdin 收信封，stdout 回结果', async () => {
    const { SubprocessTransport } = await import('../../../src/advance/agents/transports.js');
    // 从 stdin 读信封，回显 input.value+1
    const script = `
      let data='';process.stdin.on('data',c=>data+=c).on('end',()=>{
        const env=JSON.parse(data);
        console.log(JSON.stringify({status:'completed',output:{value:env.input.value+1},artifacts:[]}));
      });`;
    const transport = new SubprocessTransport({ command: process.execPath, args: ['-e', script] });
    const result = await transport.execute(baseEnvelope);
    expect(result.status).toBe('completed');
    expect(result.output.value).toBe(42);
  });

  it('退出码非零视为 failed 并带 stderr 尾部', async () => {
    const { SubprocessTransport } = await import('../../../src/advance/agents/transports.js');
    const transport = new SubprocessTransport({
      command: process.execPath,
      args: ['-e', 'console.error("炸了");process.exit(2)'],
    });
    const result = await transport.execute(baseEnvelope);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('炸了');
  });
});

describe('A2aTransport', () => {
  it('POST /tasks 提交信封并解析结果', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
        return {
          ok: true,
          json: async () => ({ status: 'completed', output: { ack: true }, artifacts: [] }),
          text: async () => '',
        } as Response;
      })
    );
    try {
      const transport = new A2aTransport({ endpoint: 'http://agent.example.invalid' });
      const result = await transport.execute(baseEnvelope);
      expect(result.status).toBe('completed');
      expect(calls[0].url).toBe('http://agent.example.invalid/tasks');
      expect((calls[0].body as TaskEnvelope).capability).toBe('echo');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('端点不可达时 probe 为 false、execute 返回 failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('连接失败')))
    );
    try {
      const transport = new A2aTransport({ endpoint: 'http://agent.example.invalid' });
      expect(await transport.probe()).toBe(false);
      const result = await transport.execute(baseEnvelope);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('连接失败');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
