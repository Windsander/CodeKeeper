import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EverOSMcpServer } from '../../../../src/advance/classic/memory/everos-mcp-server.js';

describe('EverOSMcpServer', () => {
  let server: EverOSMcpServer;
  let url: string;

  beforeAll(async () => {
    server = new EverOSMcpServer({ everosUrl: 'http://127.0.0.1:9999' });
    url = await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('启动后返回本地 URL', () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
