import { loadConfig, type Config } from '../src/config.js';
import { GraphClient } from '../src/graph.js';
import { IdempotencyStore } from '../src/idempotency.js';
import type { Ctx } from '../src/tools.js';

export const USER_TOKEN = 'EAAusertoken1234567890abcdefXYZ';
export const PAGE_TOKEN = 'EAApagetoken1234567890abcdefXYZ';
export const PAGE_ID = '111';

export function testConfig(env: Record<string, string> = {}, root = process.cwd()): Config {
  return loadConfig({ FB_USER_ACCESS_TOKEN: USER_TOKEN, FB_APP_SECRET: 'appsecret-0123456789', ...env }, root);
}

export interface Call {
  method: string;
  url: URL;
  body: URLSearchParams | FormData | undefined;
}

/** Fake Graph API: answers me/accounts, records every call, and returns `reply` for the rest. */
export function fakeFetch(reply: (c: Call) => { status?: number; json: unknown } = () => ({ json: { id: 'ok' } })) {
  const calls: Call[] = [];
  const fn = (async (input: string, init: RequestInit) => {
    const call: Call = { method: init.method ?? 'GET', url: new URL(input), body: init.body as any };
    calls.push(call);
    let out: { status?: number; json: unknown };
    if (call.url.pathname.endsWith('/me/accounts')) {
      out = { json: { data: [{ id: PAGE_ID, name: 'Test Page', access_token: PAGE_TOKEN, tasks: ['CREATE_CONTENT'] }] } };
    } else {
      out = reply(call);
    }
    return new Response(JSON.stringify(out.json), { status: out.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

export function testCtx(env: Record<string, string> = {}, reply?: Parameters<typeof fakeFetch>[0], root?: string) {
  const cfg = testConfig(env, root);
  const f = fakeFetch(reply);
  const ctx: Ctx = { cfg, graph: new GraphClient(cfg, f.fn), idem: new IdempotencyStore(60_000) };
  return { ctx, calls: f.calls };
}

/** Value of a param whether it went in the query string or the body. */
export function param(c: Call, key: string): string | null {
  if (c.body instanceof URLSearchParams) return c.body.get(key);
  if (c.body instanceof FormData) return (c.body.get(key) as string | null) ?? null;
  return c.url.searchParams.get(key);
}
