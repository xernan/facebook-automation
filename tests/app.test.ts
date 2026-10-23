import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import dotenv from 'dotenv';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/app.js';
import { configSchema, loadConfig } from '../src/config.js';
import { tools, type Ctx } from '../src/tools.js';
import { USER_TOKEN, testCtx } from './helpers.js';

async function connect(loadCtx: () => Ctx) {
  const { server } = createServer(loadCtx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textOf = (r: any) => r.content[0].text as string;

describe('MCP server', () => {
  it('starts in setup mode when .env is missing, instead of failing to connect', async () => {
    const client = await connect(() => loadConfig({}, '.') as never);
    const list = await client.listTools();
    expect(list.tools).toHaveLength(tools.length + 1);

    const status = JSON.parse(textOf(await client.callTool({ name: 'fb_setup_status', arguments: {} })));
    expect(status.ready).toBe(false);
    expect(status.problem).toMatch(/Missing token/);

    const r: any = await client.callTool({ name: 'fb_list_pages', arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Setup needed/);
  });

  it('reports ready without leaking secrets, and runs tools', async () => {
    const { ctx } = testCtx();
    const client = await connect(() => ctx);
    const raw = textOf(await client.callTool({ name: 'fb_setup_status', arguments: {} }));
    expect(JSON.parse(raw)).toMatchObject({ ready: true, writes_enabled: false, appsecret_proof: true, token_type: 'user' });
    expect(raw).not.toContain(USER_TOKEN);

    const pages = JSON.parse(textOf(await client.callTool({ name: 'fb_list_pages', arguments: {} })));
    expect(pages[0].id).toBe('111');
  });

  it('returns blocked writes as tool errors', async () => {
    const { ctx } = testCtx();
    const client = await connect(() => ctx);
    const r: any = await client.callTool({ name: 'fb_create_post', arguments: { page_id: '111', message: 'hi' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/turned off/);
  });
});

describe('.env.example', () => {
  it('parses to blank values (inline # comments are not values) and loads as defaults', () => {
    const env = dotenv.parse(readFileSync('.env.example'));
    for (const [k, v] of Object.entries(env)) {
      if (k !== 'FB_WRITE_ENABLED') expect(v, k).toBe('');
    }
    expect(env.FB_WRITE_ENABLED).toBe('false');
    const cfg = loadConfig({ ...env, FB_USER_ACCESS_TOKEN: USER_TOKEN }, '.');
    expect(cfg.FB_GRAPH_VERSION).toBe('v26.0');
    expect(cfg.FB_WRITE_ENABLED).toBe(false);
  });

  it('documents every config key', () => {
    const env = dotenv.parse(readFileSync('.env.example'));
    for (const key of Object.keys(configSchema.shape)) expect(env, key).toHaveProperty(key);
  });
});
