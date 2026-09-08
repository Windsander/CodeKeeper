/**
 * 外部 Agent 传输适配器。
 *
 * 三种传输：
 * - subprocess：本地 CLI Agent（stdin 收 JSON 信封，stdout 回 JSON 结果）
 * - a2a：远程 A2A 风格 HTTP Agent（POST /tasks；GET /.well-known/agent.json 探测）。
 *   注意：这是 A2A 词汇的最小映射，**不与现网完整 A2A 协议互通**
 *   （真实 A2A 走 JSON-RPC message/send/tasks/get），完整适配留给后续里程碑。
 * - mcp：MCP 工具调用（SSE transport）
 *
 * 约束（RULES）：subprocess 的 command 必须是可执行文件（Windows 上 .cmd/.bat
 * 封装需经 shell，请注册包装脚本）；TaskResult 经 zod 校验，非法形状一律 failed。
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { AgentCapabilityCard, TaskEnvelope, TaskResult } from './task-envelope.js';

export interface AgentTransport {
  readonly kind: AgentCapabilityCard['transport'];
  /** 健康探测（不执行任务） */
  probe(): Promise<boolean>;
  execute(envelope: TaskEnvelope): Promise<TaskResult>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5_000;
/** stdout/stderr 累积上限，失控对端不致撑爆内存 */
const MAX_OUTPUT_CHARS = 5 * 1024 * 1024;

/** TaskResult 形状校验：对端返回垃圾时一律收敛为 failed */
const taskResultSchema = z.object({
  status: z.enum(['completed', 'failed']),
  output: z.record(z.unknown()).default({}),
  artifacts: z
    .array(z.object({ name: z.string(), type: z.string(), content: z.string() }))
    .default([]),
  error: z.string().optional(),
});

export function parseTaskResult(raw: unknown): TaskResult {
  const parsed = taskResultSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'failed', output: {}, artifacts: [], error: '对端返回的 TaskResult 形状非法' };
  }
  return parsed.data;
}

function failure(error: unknown): TaskResult {
  const message = error instanceof Error ? error.message : String(error);
  return { status: 'failed', output: {}, artifacts: [], error: message };
}

/**
 * 本地子进程传输：适用于 OpenCode 类 CLI Agent 的脚本化接入。
 * 约定：信封 JSON 写 stdin，结果 JSON 从 stdout 读；进程退出码非零视为 failed。
 */
export class SubprocessTransport implements AgentTransport {
  readonly kind = 'subprocess' as const;

  constructor(private readonly spec: { command: string; args?: string[] }) {}

  async probe(): Promise<boolean> {
    return new Promise(resolve => {
      const child = spawn(this.spec.command, [...(this.spec.args ?? []), '--version'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(false);
      }, PROBE_TIMEOUT_MS);
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on('exit', code => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  }

  async execute(envelope: TaskEnvelope): Promise<TaskResult> {
    const timeoutMs = envelope.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise(resolve => {
      const child = spawn(this.spec.command, this.spec.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (result: TaskResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle(failure(`子进程执行超时（${timeoutMs}ms）`));
      }, timeoutMs);

      child.stdout.on('data', chunk => {
        if (stdout.length < MAX_OUTPUT_CHARS) stdout += String(chunk);
      });
      child.stderr.on('data', chunk => {
        if (stderr.length < MAX_OUTPUT_CHARS) stderr += String(chunk);
      });
      // 子进程早退不读 stdin 时，写入会触发 EPIPE——由 exit 路径统一收敛为 failed
      child.stdin.on('error', () => undefined);
      child.on('error', error => settle(failure(error)));
      child.on('exit', code => {
        if (code !== 0) {
          settle(failure(`子进程退出码 ${code}: ${stderr.slice(-500)}`));
          return;
        }
        try {
          settle(parseTaskResult(JSON.parse(stdout)));
        } catch {
          settle(failure(`子进程输出不是合法 TaskResult JSON: ${stdout.slice(-500)}`));
        }
      });
      child.stdin.write(JSON.stringify(envelope));
      child.stdin.end();
    });
  }
}

/**
 * A2A 风格 HTTP 传输：远程第三方 Agent。
 * 约定（A2A 词汇的最小映射）：GET /.well-known/agent.json 取能力卡片；
 * POST /tasks 提交信封，返回任务结果。与完整 A2A 协议的映射留给后续适配。
 */
export class A2aTransport implements AgentTransport {
  readonly kind = 'a2a' as const;
  private readonly endpoint: string;

  constructor(spec: { endpoint: string }) {
    // 归一化尾部斜杠，避免 //tasks
    this.endpoint = spec.endpoint.replace(/\/+$/, '');
  }

  async probe(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/.well-known/agent.json`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async execute(envelope: TaskEnvelope): Promise<TaskResult> {
    const timeoutMs = envelope.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const response = await fetch(`${this.endpoint}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return failure(`A2A 端点 ${response.status}: ${(await response.text()).slice(-500)}`);
      }
      return parseTaskResult(await response.json());
    } catch (error) {
      return failure(error);
    }
  }

  /** 拉取对端能力卡片（注册表探测/展示用） */
  async fetchCard(): Promise<AgentCapabilityCard | null> {
    try {
      const response = await fetch(`${this.endpoint}/.well-known/agent.json`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2),
      });
      if (!response.ok) return null;
      return (await response.json()) as AgentCapabilityCard;
    } catch {
      return null;
    }
  }
}

/** MCP 工具传输：把任务信封作为 MCP 工具的入参调用 */
export class McpTransport implements AgentTransport {
  readonly kind = 'mcp' as const;

  constructor(private readonly spec: { serverUrl: string; tool: string }) {}

  async probe(): Promise<boolean> {
    const client = new Client({ name: 'codekeeper-agent-probe', version: '0.1.0' });
    try {
      await client.connect(new SSEClientTransport(new URL('/sse', this.spec.serverUrl)));
      const tools = await client.listTools();
      return tools.tools.some(tool => tool.name === this.spec.tool);
    } catch {
      return false;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async execute(envelope: TaskEnvelope): Promise<TaskResult> {
    const timeoutMs = envelope.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const client = new Client({ name: 'codekeeper-agent-mcp', version: '0.1.0' });
    try {
      const work = (async () => {
        await client.connect(new SSEClientTransport(new URL('/sse', this.spec.serverUrl)));
        const result = await client.callTool({
          name: this.spec.tool,
          arguments: { envelope },
        });
        const text = (result.content as Array<{ type: string; text?: string }>)
          .filter(part => part.type === 'text')
          .map(part => part.text ?? '')
          .join('\n');
        try {
          return parseTaskResult(JSON.parse(text));
        } catch {
          // 对端未回结构化结果：整体作为单产物返回
          return {
            status: 'completed' as const,
            output: { result: text },
            artifacts: [{ name: 'result', type: 'Text', content: text }],
          };
        }
      })();
      return await withTimeout(work, timeoutMs);
    } catch (error) {
      return failure(error);
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

/** 超时就拒绝的包装（MCP 传输等原生不支持超时的路径用） */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`执行超时（${timeoutMs}ms）`)), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
