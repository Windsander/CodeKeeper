/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { handlers } from '../../../src/advance/ipc/handlers';
import type { HandlerContext } from '../../../src/advance/ipc/handlers';

describe('daemon.status handler', () => {
  it('返回 daemon 运行状态与 EverOS 状态', async () => {
    const ctx: HandlerContext = {
      store: {} as HandlerContext['store'],
      registry: {} as HandlerContext['registry'],
      serviceRegistry: {} as HandlerContext['serviceRegistry'],
      dbPath: '/tmp/db.sqlite',
      getClient: () => null,
      isDaemonRunning: () => true,
      getEverosStatus: () => ({
        state: 'running',
        url: 'http://127.0.0.1:8000',
        error: null,
      }),
    };

    const result = await handlers['daemon.status'](ctx, undefined);
    expect(result).toEqual({
      daemonRunning: true,
      everos: { state: 'running', url: 'http://127.0.0.1:8000', error: null },
    });
  });

  it('缺少回调时返回安全默认值', async () => {
    const ctx: HandlerContext = {
      store: {} as HandlerContext['store'],
      registry: {} as HandlerContext['registry'],
      serviceRegistry: {} as HandlerContext['serviceRegistry'],
      dbPath: '/tmp/db.sqlite',
      getClient: () => null,
    };

    const result = await handlers['daemon.status'](ctx, undefined);
    expect(result).toEqual({
      daemonRunning: false,
      everos: { state: 'idle', url: null, error: null },
    });
  });
});

describe('localModel.status handler', () => {
  it('返回 embedding 与 rerank 状态', async () => {
    const ctx: HandlerContext = {
      store: {} as HandlerContext['store'],
      registry: {} as HandlerContext['registry'],
      serviceRegistry: {} as HandlerContext['serviceRegistry'],
      dbPath: '/tmp/db.sqlite',
      getClient: () => null,
      localModelManager: {
        getStatus: () => ({
          embedding: { state: 'running', url: 'http://127.0.0.1:12345', error: null },
          rerank: { state: 'idle', url: null, error: null },
        }),
      } as unknown as HandlerContext['localModelManager'],
    };

    const result = await handlers['localModel.status'](ctx, undefined);
    expect(result).toEqual({
      embedding: { state: 'running', url: 'http://127.0.0.1:12345', error: null },
      rerank: { state: 'idle', url: null, error: null },
    });
  });
});
