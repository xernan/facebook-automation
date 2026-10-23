import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/app.js';
import { GraphClient } from '../src/graph.js';
import { IdempotencyStore } from '../src/idempotency.js';
import { callTool, tools, type Ctx } from '../src/tools.js';
import { PAGE_TOKEN, testConfig, testCtx } from './helpers.js';

const tool = (name: string) => tools.find((d) => d.name === name)!;
const WRITE_ON = { FB_WRITE_ENABLED: 'true' };

describe('tool output never carries tokens', () => {
  it('scrubs a page token that a Graph read returns', async () => {
    const { ctx } = testCtx({}, () => ({ json: { id: '111', access_token: PAGE_TOKEN } }));
    const { server } = createServer(() => ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r: any = await client.callTool({ name: 'fb_graph_get', arguments: { page_id: '111', path: '111' } });
    expect(r.content[0].text).not.toContain(PAGE_TOKEN);
  });

  it('fb_graph_get refuses to ask for token fields', async () => {
    const { ctx } = testCtx();
    await expect(
      callTool(tool('fb_graph_get'), { page_id: '111', path: '111', params: { fields: 'name,access_token' } }, ctx),
    ).rejects.toThrow(/Auth/);
  });
});

describe('write that times out', () => {
  function timeoutCtx() {
    const cfg = testConfig(WRITE_ON);
    let posts = 0;
    const fn = (async (input: string, init: RequestInit) => {
      const u = new URL(input);
      if (u.pathname.endsWith('/me/accounts'))
        return new Response(JSON.stringify({ data: [{ id: '111', name: 'P', access_token: PAGE_TOKEN }] }));
      if (u.pathname.endsWith('/debug_token')) return new Response(JSON.stringify({ data: {} }));
      if (init.method === 'POST') {
        posts++;
        throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); // sent, but no answer
      }
      return new Response('{}');
    }) as unknown as typeof fetch;
    const ctx: Ctx = { cfg, graph: new GraphClient(cfg, fn), idem: new IdempotencyStore(60_000) };
    return { ctx, posts: () => posts };
  }

  it('does not post again when retried with the same key', async () => {
    const { ctx, posts } = timeoutCtx();
    const args = { page_id: '111', message: 'hi', idempotency_key: 'post-key-1' };
    await expect(callTool(tool('fb_create_post'), args, ctx)).rejects.toThrow(/may have gone through/);
    await expect(callTool(tool('fb_create_post'), args, ctx)).rejects.toThrow(/may have gone through/);
    expect(posts()).toBe(1);
  });
});

describe('idempotency key reuse', () => {
  it('refuses the same key for a different action instead of silently skipping it', async () => {
    const { ctx, calls } = testCtx(WRITE_ON);
    await callTool(tool('fb_create_post'), { page_id: '111', message: 'first', idempotency_key: 'same-key-1' }, ctx);
    await expect(
      callTool(tool('fb_create_post'), { page_id: '111', message: 'second', idempotency_key: 'same-key-1' }, ctx),
    ).rejects.toThrow(/different action/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('still replays the same action with the same key', async () => {
    const { ctx, calls } = testCtx(WRITE_ON);
    const args = { page_id: '111', message: 'same', idempotency_key: 'same-key-2' };
    await callTool(tool('fb_create_post'), args, ctx);
    const r: any = await callTool(tool('fb_create_post'), args, ctx);
    expect(r.replayed).toBe(true);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});

describe('fb_comment_leads paging', () => {
  it('reads every page of comments on a post, not just the first', async () => {
    const { ctx } = testCtx({}, (c) => {
      if (c.url.searchParams.get('after') === 'p2')
        return { json: { data: [{ id: 'c2', from: { id: '6', name: 'Cy' }, message: 'hm' }] } };
      return {
        json: {
          data: [{ id: 'c1', from: { id: '5', name: 'Ben' }, message: 'hm' }],
          paging: { next: 'x', cursors: { after: 'p2' } },
        },
      };
    });
    const res: any = await callTool(tool('fb_comment_leads'), { page_id: '111', post_id: '111_1' }, ctx);
    expect(res.leads.map((l: any) => l.ref_id)).toEqual(['c1', 'c2']);
  });
});

describe('paging cursors', () => {
  it('every list tool accepts a long Meta cursor (live cursors run over 1,000 chars)', async () => {
    const cursor = 'QVFIV' + 'GRtVlctVGp3QXZACaWJ'.repeat(60) + 'ZDZD';
    const { ctx } = testCtx({}, () => ({ json: { data: [] } }));
    const listTools = tools.filter((t) => 'after' in t.input);
    expect(listTools.length).toBeGreaterThan(3);
    for (const t of listTools) {
      const args: Record<string, string> = { page_id: '111', after: cursor };
      if ('object_id' in t.input) args.object_id = '111_1';
      if ('conversation_id' in t.input) args.conversation_id = 't_1';
      await expect(callTool(t, args, ctx), t.name).resolves.toBeDefined();
    }
  });

  it('rejects a cursor with characters Meta never uses', async () => {
    const { ctx } = testCtx();
    await expect(callTool(tool('fb_list_posts'), { page_id: '111', after: 'a&access_token=x' }, ctx)).rejects.toThrow();
  });
});
