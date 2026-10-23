import { describe, expect, it } from 'vitest';
import { REQUIRED_PERMISSIONS } from '../src/graph.js';
import { buildLoginUrl, exchangeCode, setEnvValue } from '../src/oauth.js';
import { APP_SECRET, testConfig } from './helpers.js';

describe('login url', () => {
  it('asks for every required permission with state and a localhost redirect', () => {
    const u = new URL(buildLoginUrl(testConfig(), '42', 'http://localhost:8765/callback', 'abc'));
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth');
    expect(u.searchParams.get('scope')!.split(',')).toEqual([...REQUIRED_PERMISSIONS]);
    expect(u.searchParams.get('state')).toBe('abc');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:8765/callback');
    expect(u.toString()).not.toContain(APP_SECRET);
  });

  it('can skip the Lead Ads permissions', () => {
    const u = new URL(buildLoginUrl(testConfig(), '42', 'http://localhost/cb', 's', { leads: false }));
    const scope = u.searchParams.get('scope')!.split(',');
    expect(scope).not.toContain('leads_retrieval');
    expect(scope).not.toContain('pages_manage_ads');
    expect(scope).toContain('pages_manage_engagement');
  });
});

describe('exchangeCode', () => {
  it('swaps the code for a short token, then for a long-lived one', async () => {
    const seen: URL[] = [];
    const fn = (async (input: string) => {
      const u = new URL(input);
      seen.push(u);
      const token = u.searchParams.get('code') ? 'SHORT' : 'LONG';
      return new Response(JSON.stringify({ access_token: token }));
    }) as unknown as typeof fetch;
    const t = await exchangeCode(testConfig(), '42', 'CODE', 'http://localhost:8765/callback', fn);
    expect(t).toBe('LONG');
    expect(seen[1]!.searchParams.get('grant_type')).toBe('fb_exchange_token');
    expect(seen[1]!.searchParams.get('fb_exchange_token')).toBe('SHORT');
  });

  it('reports Meta errors without echoing the response', async () => {
    const fn = (async () =>
      new Response(JSON.stringify({ error: { message: 'Invalid verification code' } }), { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeCode(testConfig(), '42', 'bad', 'http://localhost/cb', fn)).rejects.toThrow(/Invalid verification code/);
  });

  it('says "No internet connection" when offline', async () => {
    const fn = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(exchangeCode(testConfig(), '42', 'c', 'http://localhost/cb', fn)).rejects.toThrow('No internet connection');
  });
});

describe('setEnvValue', () => {
  it('replaces only the given key and keeps CRLF line endings', () => {
    const before = 'A=1\r\nFB_USER_ACCESS_TOKEN=old\r\nFB_PAGE_ACCESS_TOKEN=\r\n';
    expect(setEnvValue(before, 'FB_USER_ACCESS_TOKEN', 'new')).toBe('A=1\r\nFB_USER_ACCESS_TOKEN=new\r\nFB_PAGE_ACCESS_TOKEN=\r\n');
  });

  it('appends a missing key', () => {
    expect(setEnvValue('A=1', 'FB_APP_ID', '42')).toBe('A=1\nFB_APP_ID=42\n');
  });

  it('treats $ in values literally and refuses multi-line values', () => {
    expect(setEnvValue('K=x\n', 'K', 'a$&b')).toBe('K=a$&b\n');
    expect(() => setEnvValue('', 'K', 'a\nB=evil')).toThrow();
  });
});
