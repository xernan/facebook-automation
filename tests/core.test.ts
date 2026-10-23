import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { csvCell, leadsToCsv } from '../src/files.js';
import { explainGraphError } from '../src/graph.js';
import { IdempotencyStore } from '../src/idempotency.js';
import { RateLimiter } from '../src/ratelimit.js';
import { redact } from '../src/redact.js';
import { toScheduleTimestamp } from '../src/schedule.js';
import { APP_SECRET, PAGE_TOKEN, USER_TOKEN, param, testConfig, testCtx } from './helpers.js';

describe('config', () => {
  it('applies defaults', () => {
    const c = testConfig();
    expect(c.FB_GRAPH_VERSION).toBe('v26.0');
    expect(c.FB_WRITE_ENABLED).toBe(false);
    expect(c.FB_WRITE_RATE_PER_MIN).toBe(10);
  });

  it('rejects out-of-bounds tunables without echoing values', () => {
    expect(() => testConfig({ FB_WRITE_RATE_PER_MIN: '1000' })).toThrow(/FB_WRITE_RATE_PER_MIN/);
    expect(() => testConfig({ FB_SCHEDULE_MAX_DAYS: '0' })).toThrow(/FB_SCHEDULE_MAX_DAYS/);
    try {
      loadConfig({ FB_USER_ACCESS_TOKEN: 'short' }, '.');
    } catch (e) {
      expect((e as Error).message).not.toContain('short');
    }
  });

  it('requires a token', () => {
    expect(() => loadConfig({}, '.')).toThrow(/Missing token/);
  });

  it('only "true" turns writes on', () => {
    expect(testConfig({ FB_WRITE_ENABLED: 'true' }).FB_WRITE_ENABLED).toBe(true);
    expect(() => testConfig({ FB_WRITE_ENABLED: 'yes' })).toThrow();
  });
});

describe('redact', () => {
  it('removes tokens from text', () => {
    const out = redact(`https://x?access_token=${USER_TOKEN}&a=1 and ${PAGE_TOKEN}`);
    expect(out).not.toContain(USER_TOKEN);
    expect(out).not.toContain(PAGE_TOKEN);
    expect(out).toContain('access_token=[REDACTED]');
  });

  it('removes known secrets that do not look like tokens', () => {
    expect(redact('secret is hunter2hunter2', ['hunter2hunter2'])).toBe('secret is [REDACTED]');
  });
});

describe('rate limiter', () => {
  it('blocks after N calls per minute and frees up after 60s', () => {
    let t = 0;
    const rl = new RateLimiter(2, () => t);
    expect(rl.take()).toBe(0);
    expect(rl.take()).toBe(0);
    expect(rl.take()).toBeGreaterThan(0);
    t = 60_000;
    expect(rl.take()).toBe(0);
  });
});

describe('idempotency', () => {
  it('runs a keyed action once even when called concurrently', async () => {
    const store = new IdempotencyStore(60_000);
    let runs = 0;
    const fn = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 10));
      return 'done';
    };
    const [a, b] = await Promise.all([store.run('key-12345', fn), store.run('key-12345', fn)]);
    expect(runs).toBe(1);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  });

  it('allows retry with the same key after a failure', async () => {
    const store = new IdempotencyStore(60_000);
    await expect(store.run('key-12345', async () => { throw new Error('x'); })).rejects.toThrow();
    expect((await store.run('key-12345', async () => 'ok')).result).toBe('ok');
  });

  it('expires keys after the TTL', async () => {
    let t = 0;
    const store = new IdempotencyStore(1000, () => t);
    let runs = 0;
    await store.run('key-12345', async () => ++runs);
    t = 2000;
    await store.run('key-12345', async () => ++runs);
    expect(runs).toBe(2);
  });
});

describe('schedule', () => {
  const now = Date.parse('2026-10-23T00:00:00Z');
  it('accepts a time inside the window', () => {
    expect(toScheduleTimestamp('2026-10-24T08:00:00+08:00', 10, 30, now)).toBe(Date.parse('2026-10-24T00:00:00Z') / 1000);
  });
  it('rejects missing timezone, too soon, and too far', () => {
    expect(() => toScheduleTimestamp('2026-10-24T08:00:00', 10, 30, now)).toThrow(/timezone/);
    expect(() => toScheduleTimestamp('2026-10-23T00:05:00Z', 10, 30, now)).toThrow(/at least 10 minutes/);
    expect(() => toScheduleTimestamp('2026-12-30T00:00:00Z', 10, 30, now)).toThrow(/within 30 days/);
  });
});

describe('csv', () => {
  it('quotes and blocks formula injection', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+639171234567')).toBe("'+639171234567");
    expect(csvCell('a,b')).toBe('"a,b"');
  });
  it('builds one column per form field', () => {
    const csv = leadsToCsv([
      { id: '1', field_data: [{ name: 'email', values: ['a@b.c'] }] },
      { id: '2', field_data: [{ name: 'phone_number', values: ['0917'] }] },
    ]);
    const [header, r1, r2] = csv.trim().split('\r\n');
    expect(header).toBe('lead_id,created_time,form_id,ad_id,email,phone_number');
    expect(r1).toBe('1,,,,a@b.c,');
    expect(r2).toBe('2,,,,,0917');
  });
});

describe('graph client', () => {
  it('uses the page token with appsecret_proof, never the user token, for page calls', async () => {
    const { ctx, calls } = testCtx();
    await ctx.graph.get('111', '111/posts');
    const call = calls.at(-1)!;
    expect(param(call, 'access_token')).toBe(PAGE_TOKEN);
    const proof = createHmac('sha256', APP_SECRET).update(PAGE_TOKEN).digest('hex');
    expect(param(call, 'appsecret_proof')).toBe(proof);
    expect(call.url.pathname).toBe('/v26.0/111/posts');
  });

  it('refuses pages the token does not manage', async () => {
    const { ctx } = testCtx();
    await expect(ctx.graph.get('999', '999/posts')).rejects.toThrow(/not managed/);
  });

  it('maps Meta errors and scrubs tokens from them', async () => {
    const { ctx } = testCtx({}, () => ({
      status: 400,
      json: { error: { type: 'OAuthException', code: 190, message: `bad token ${PAGE_TOKEN}` } },
    }));
    const err = await ctx.graph.get('111', '111').catch((e) => e as Error);
    expect(err.message).toMatch(/invalid or expired/);
    expect(err.message).not.toContain(PAGE_TOKEN);
  });

  it('says "No internet connection" when the network is down', async () => {
    const cfg = testConfig();
    const { GraphClient } = await import('../src/graph.js');
    const g = new GraphClient(cfg, (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
    await expect(g.listPages()).rejects.toThrow('No internet connection');
  });

  it('finds Business-owned Pages that me/accounts leaves out', async () => {
    const { GraphClient } = await import('../src/graph.js');
    const seen: string[] = [];
    const fn = (async (input: string) => {
      const u = new URL(input);
      seen.push(u.pathname);
      const json = u.pathname.endsWith('/me/accounts')
        ? { data: [] }
        : u.pathname.endsWith('/debug_token')
          ? { data: { granular_scopes: [{ scope: 'pages_show_list', target_ids: ['222'] }] } }
          : u.pathname.endsWith('/222')
            ? { id: '222', name: 'Biz Page', access_token: PAGE_TOKEN }
            : { error: { code: 100, message: 'nope' } };
      return new Response(JSON.stringify(json), { status: 'error' in json ? 400 : 200 });
    }) as unknown as typeof fetch;
    const g = new GraphClient(testConfig(), fn);
    expect((await g.listPages()).map((p) => p.name)).toEqual(['Biz Page']);
    expect(await g.pageToken('222')).toBe(PAGE_TOKEN);
    await expect(g.pageToken('333')).rejects.toThrow(/not managed/);
  });

  it('reaches a Business Page by direct id when the token covers all Pages', async () => {
    const { GraphClient } = await import('../src/graph.js');
    const fn = (async (input: string) => {
      const u = new URL(input);
      const json = u.pathname.endsWith('/me/accounts')
        ? { data: [] }
        : u.pathname.endsWith('/debug_token')
          ? { data: { granular_scopes: [{ scope: 'pages_show_list' }] } }
          : u.pathname.endsWith('/222')
            ? { id: '222', name: 'Biz Page', access_token: PAGE_TOKEN }
            : u.pathname.endsWith('/333')
              ? { id: '333', name: 'Someone else' }
              : { error: { code: 100, message: 'nope' } };
      return new Response(JSON.stringify(json), { status: 'error' in json ? 400 : 200 });
    }) as unknown as typeof fetch;
    const g = new GraphClient(testConfig(), fn);
    expect(await g.listPages()).toEqual([]);
    expect(await g.pageToken('222')).toBe(PAGE_TOKEN);
    await expect(g.pageToken('333')).rejects.toThrow(/not managed/);
    await expect(g.pageToken('444')).rejects.toThrow(/not managed/);

    const listed = new GraphClient(testConfig({ FB_EXTRA_PAGE_IDS: '222, 333' }), fn);
    expect((await listed.listPages()).map((p) => p.id)).toEqual(['222']);
  });

  it('lists missing permissions from me/permissions', async () => {
    const { ctx, calls } = testCtx({}, () => ({
      json: { data: [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'pages_messaging', status: 'declined' }] },
    }));
    const res = await ctx.graph.checkPermissions();
    expect(calls.at(-1)!.url.pathname).toBe('/v26.0/me/permissions');
    expect(param(calls.at(-1)!, 'access_token')).toBe(USER_TOKEN);
    expect(res!.granted).toEqual(['pages_show_list']);
    expect(res!.missing).toContain('pages_messaging');
    expect(res!.missing).not.toContain('pages_show_list');
  });

  it('enforces the local write limit', async () => {
    const { ctx } = testCtx({ FB_WRITE_RATE_PER_MIN: '1' });
    await ctx.graph.post('111', '111/feed', { message: 'a' });
    await expect(ctx.graph.post('111', '111/feed', { message: 'b' })).rejects.toThrow(/write limit/);
  });

  it('explains the messaging window error before the generic permission error', () => {
    expect(explainGraphError(10, 2018278, 'raw')).toMatch(/24-hour/);
    expect(explainGraphError(10, undefined, 'raw')).toMatch(/permission/);
  });

  it('points retired insights metrics to their replacement', () => {
    expect(explainGraphError(100, undefined, '(#100) The value must be a valid insights metric')).toMatch(
      /page_total_media_view_unique/,
    );
  });
});

describe('process exit', () => {
  // process.exit() with open fetch sockets crashes Node on Windows (libuv assertion). Use exitCode.
  it('src never calls process.exit()', () => {
    for (const f of readdirSync('src')) {
      expect(readFileSync(path.join('src', f), 'utf8'), f).not.toMatch(/process\.exit\(/);
    }
  });
});

describe('source hygiene', () => {
  // A broken edit once turned regex \b into a backspace character, silently breaking matches.
  it('src has no stray control characters', () => {
    for (const f of readdirSync('src')) {
      expect(readFileSync(path.join('src', f), 'utf8'), f).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
    }
  });
});
