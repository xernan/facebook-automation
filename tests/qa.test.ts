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

describe('unknown page ids', () => {
  it('do not re-fetch the page list on every call (cooldown)', async () => {
    const { ctx, calls } = testCtx({}, () => ({ status: 400, json: { error: { code: 100, error_subcode: 33, message: 'x' } } }));
    for (let i = 0; i < 5; i++) {
      await expect(callTool(tool('fb_list_posts'), { page_id: '999' }, ctx)).rejects.toThrow(/not managed/);
    }
    const listCalls = calls.filter((c) => c.url.pathname.endsWith('/me/accounts')).length;
    expect(listCalls).toBeLessThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(6);
  });
});

describe('messenger leads page size', () => {
  it('comes from config, not a hard-coded number', async () => {
    const { ctx, calls } = testCtx({ FB_LEADS_CHATS_PER_PAGE: '7' }, () => ({ json: { data: [] } }));
    await callTool(tool('fb_messenger_leads'), { page_id: '111' }, ctx);
    expect(calls.at(-1)!.url.searchParams.get('limit')).toBe('7');
  });
});

describe('fb_list_pages for Business Pages', () => {
  it('says a Page found by direct lookup is usable, instead of showing no tasks', async () => {
    const { ctx } = testCtx({ FB_EXTRA_PAGE_IDS: '222' }, (c) =>
      c.url.pathname.endsWith('/222') ? { json: { id: '222', name: 'Biz', access_token: 'EAAbizpagetoken1234567890abcdef' } } : { json: {} },
    );
    const pages: any = await callTool(tool('fb_list_pages'), {}, ctx);
    const biz = pages.find((p: any) => p.id === '222');
    expect(biz.access).toMatch(/Business/);
  });
});

describe('write whose answer is cut off mid-body', () => {
  it('is marked as maybe done, so a retry with the same key does not post twice', async () => {
    const cfg = testConfig(WRITE_ON);
    let posts = 0;
    const fn = (async (input: string, init: RequestInit) => {
      const u = new URL(input);
      if (u.pathname.endsWith('/me/accounts'))
        return new Response(JSON.stringify({ data: [{ id: '111', name: 'P', access_token: PAGE_TOKEN }] }));
      if (u.pathname.endsWith('/debug_token')) return new Response(JSON.stringify({ data: {} }));
      if (init.method === 'POST') {
        posts++;
        const body = new ReadableStream({ start: (c) => c.error(new TypeError('terminated')) });
        return new Response(body, { status: 200 });
      }
      return new Response('{}');
    }) as unknown as typeof fetch;
    const ctx: Ctx = { cfg, graph: new GraphClient(cfg, fn), idem: new IdempotencyStore(60_000) };
    const args = { page_id: '111', message: 'hi', idempotency_key: 'cut-key-1' };
    await expect(callTool(tool('fb_create_post'), args, ctx)).rejects.toThrow(/may have gone through/);
    await expect(callTool(tool('fb_create_post'), args, ctx)).rejects.toThrow(/may have gone through/);
    expect(posts).toBe(1);
  });

  it('a read cut off mid-body says "No internet connection"', async () => {
    const cfg = testConfig();
    const fn = (async () =>
      new Response(new ReadableStream({ start: (c) => c.error(new TypeError('terminated')) }))) as unknown as typeof fetch;
    await expect(new GraphClient(cfg, fn).listPages()).rejects.toThrow('No internet connection');
  });
});

describe('maybe-done message', () => {
  it('does not mention idempotency_key for tools that have none', async () => {
    const cfg = testConfig(WRITE_ON);
    const fn = (async (input: string, init: RequestInit) => {
      const u = new URL(input);
      if (u.pathname.endsWith('/me/accounts'))
        return new Response(JSON.stringify({ data: [{ id: '111', name: 'P', access_token: PAGE_TOKEN }] }));
      if (u.pathname.endsWith('/debug_token')) return new Response(JSON.stringify({ data: {} }));
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    const ctx: Ctx = { cfg, graph: new GraphClient(cfg, fn), idem: new IdempotencyStore(60_000) };
    const err = await callTool(tool('fb_hide_comment'), { page_id: '111', comment_id: '1_2', hidden: true }, ctx).catch((e) => e);
    expect(err.message).toMatch(/may have gone through/);
    expect(err.message).not.toMatch(/idempotency_key/);
  });
});

describe('standard base64 cursors', () => {
  it('accepts + and / in a cursor', async () => {
    const { ctx } = testCtx({}, () => ({ json: { data: [] } }));
    await expect(callTool(tool('fb_list_posts'), { page_id: '111', after: 'MTAx+NTE/xOTQ=' }, ctx)).resolves.toBeDefined();
  });
});

describe('doctor verdict', () => {
  it('missing only Lead Ads permissions is OK, not a failure', async () => {
    const { permissionVerdict } = await import('../src/graph.js');
    expect(permissionVerdict(['leads_retrieval', 'pages_manage_ads']).ok).toBe(true);
    expect(permissionVerdict(['pages_messaging', 'leads_retrieval']).ok).toBe(false);
    expect(permissionVerdict([]).ok).toBe(true);
  });
});
