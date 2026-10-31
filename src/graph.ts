import { assertSafeContent } from './contentguard.js';
import { createHmac } from 'node:crypto';
import type { Config } from './config.js';
import { RateLimiter } from './ratelimit.js';
import { redact } from './redact.js';

export type Params = Record<string, string | number | boolean | undefined>;
type FetchFn = typeof fetch;

export class GraphError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly subcode?: number,
    readonly status?: number,
    /** A write that may have reached Meta before the connection failed. */
    readonly uncertain = false,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

// Turns Meta error codes into plain guidance Claude can act on.
export function explainGraphError(code: number | undefined, subcode: number | undefined, raw: string): string {
  if (code === 190) return `Access token is invalid or expired. Make a new token (see docs/SETUP.md). (${raw})`;
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80001)
    return `Meta rate limit reached. Wait a few minutes before retrying. (${raw})`;
  if (code === 551 || (code === 10 && subcode === 2018278))
    return `This person cannot be messaged right now (outside the 24-hour window or blocked). (${raw})`;
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299))
    return `Missing permission for this action. Check the app permissions in docs/SETUP.md. (${raw})`;
  if (code === 368) return `Meta blocked this action as possible spam or policy violation. Do not retry. (${raw})`;
  if (code === 100 && /valid insights metric/i.test(raw))
    return (
      'Meta retired this metric name. For reach use page_total_media_view_unique (Page) or ' +
      `post_total_media_view_unique (post); see the Page Insights docs for others. (${raw})`
    );
  if (code === 100 && subcode === 33) return `Object not found, or this token cannot see it. (${raw})`;
  return raw;
}

/** A failed connection. A write may already have reached Meta unless the connection never opened. */
function networkError(method: string, err: unknown): GraphError {
  const name = (err as Error)?.name;
  const timedOut = name === 'TimeoutError' || name === 'AbortError';
  const neverSent = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes((err as any)?.cause?.code);
  const first = timedOut ? 'Request timed out.' : 'No internet connection.';
  if (method !== 'GET' && !neverSent) {
    return new GraphError(`${first} The action may have gone through. Check the Page before trying again.`, undefined, undefined, undefined, true);
  }
  return new GraphError(timedOut ? 'Request timed out. Try again.' : 'No internet connection');
}

/** Permissions the tools need (docs/SETUP.md step 2). */
export const REQUIRED_PERMISSIONS = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_manage_engagement',
  'pages_read_user_content',
  'pages_manage_metadata',
  'pages_messaging',
  'read_insights',
  'leads_retrieval',
  'pages_manage_ads',
] as const;

/** Only the Lead Ads tools need these. An app needs a Lead Ads use case before Login accepts them. */
export const LEAD_PERMISSIONS: readonly string[] = ['leads_retrieval', 'pages_manage_ads'];

/** Missing Lead Ads permissions only turn off the Lead Ads tools; anything else is a real problem. */
export function permissionVerdict(missing: string[]): { ok: boolean; core: string[]; leads: string[] } {
  const leads = missing.filter((p) => LEAD_PERMISSIONS.includes(p));
  const core = missing.filter((p) => !LEAD_PERMISSIONS.includes(p));
  return { ok: core.length === 0, core, leads };
}

function extraPageIds(cfg: Config): string[] {
  return (cfg.FB_EXTRA_PAGE_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export interface PageInfo {
  id: string;
  name: string;
  access_token: string;
  tasks?: string[];
}

/** The highest percentage in Meta's usage headers, or undefined when it sent none. */
export function metaUsagePct(appUsage?: string | null, pageUsage?: string | null): number | undefined {
  const numbers: unknown[] = [];
  try {
    if (appUsage) {
      const a = JSON.parse(appUsage);
      numbers.push(a.call_count, a.total_cputime, a.total_time);
    }
    if (pageUsage) {
      for (const list of Object.values(JSON.parse(pageUsage)) as any[]) for (const u of list) numbers.push(u.call_count, u.total_cputime, u.total_time);
    }
  } catch {
    return undefined;
  }
  const valid = numbers.filter((n): n is number => typeof n === 'number');
  return valid.length ? Math.max(...valid) : undefined;
}

export class GraphClient {
  private readonly readLimiter: RateLimiter;
  private readonly writeLimiter: RateLimiter;
  private pages: Map<string, PageInfo> | undefined;
  /** Page ids that were not found, with when (for the refresh cooldown). */
  private readonly missing = new Map<string, number>();
  /** How much of its call limit Meta last reported as used (0-100). */
  usagePct = 0;

  constructor(
    private readonly cfg: Config,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.readLimiter = new RateLimiter(cfg.FB_READ_RATE_PER_MIN);
    this.writeLimiter = new RateLimiter(cfg.FB_WRITE_RATE_PER_MIN);
  }

  private get secrets(): (string | undefined)[] {
    const s = [this.cfg.FB_USER_ACCESS_TOKEN, this.cfg.FB_PAGE_ACCESS_TOKEN, this.cfg.FB_APP_SECRET];
    for (const p of this.pages?.values() ?? []) s.push(p.access_token);
    return s;
  }

  scrub(text: string): string {
    return redact(text, this.secrets);
  }

  private authParams(token: string): Params {
    const p: Params = { access_token: token };
    if (this.cfg.FB_APP_SECRET) {
      p.appsecret_proof = createHmac('sha256', this.cfg.FB_APP_SECRET).update(token).digest('hex');
    }
    return p;
  }

  private url(path: string): string {
    return `https://graph.facebook.com/${this.cfg.FB_GRAPH_VERSION}/${path.replace(/^\/+/, '')}`;
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    token: string,
    params: Params = {},
    form?: FormData,
  ): Promise<any> {
    const limiter = method === 'GET' ? this.readLimiter : this.writeLimiter;
    const wait = limiter.take();
    if (wait > 0) {
      throw new GraphError(
        `Local ${method === 'GET' ? 'read' : 'write'} limit reached. Try again in ${Math.ceil(wait / 1000)}s.`,
      );
    }

    const all: Params = { ...params, ...this.authParams(token) };
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(all)) if (v !== undefined) qs.set(k, String(v));

    let url = this.url(path);
    let body: BodyInit | undefined;
    if (form) {
      for (const [k, v] of qs) form.set(k, v);
      body = form;
    } else if (method === 'GET') {
      url += `?${qs.toString()}`;
    } else {
      body = qs;
    }

    // The connection can fail while sending or while reading Meta's answer; both go through here.
    let res: Response;
    let text: string;
    try {
      res = await this.fetchFn(url, { method, body, signal: AbortSignal.timeout(this.cfg.FB_HTTP_TIMEOUT_MS) });
      text = await res.text();
    } catch (err) {
      throw networkError(method, err);
    }
    this.usagePct = metaUsagePct(res.headers?.get('x-app-usage'), res.headers?.get('x-business-use-case-usage')) ?? this.usagePct;
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new GraphError(`Unexpected response from Meta (HTTP ${res.status}).`, undefined, undefined, res.status);
    }
    if (!res.ok || json?.error) {
      const e = json?.error ?? {};
      const raw = this.scrub(`${e.type ?? 'Error'} ${e.code ?? ''}: ${e.message ?? `HTTP ${res.status}`}`);
      throw new GraphError(explainGraphError(e.code, e.error_subcode, raw), e.code, e.error_subcode, res.status);
    }
    return json;
  }

  /** Pages this token can manage. Cached for the life of the process. */
  async listPages(refresh = false): Promise<PageInfo[]> {
    if (this.pages && !refresh) return [...this.pages.values()];
    const map = new Map<string, PageInfo>();
    if (this.cfg.FB_USER_ACCESS_TOKEN) {
      let next: string | undefined = undefined;
      do {
        const res: any = await this.request('GET', 'me/accounts', this.cfg.FB_USER_ACCESS_TOKEN, {
          fields: 'id,name,access_token,tasks',
          limit: 100,
          after: next,
        });
        for (const p of res.data ?? []) map.set(p.id, p);
        next = res.paging?.next ? res.paging?.cursors?.after : undefined;
      } while (next);
      // Pages owned by a Business Portfolio are missing from me/accounts unless the token also has
      // business_management. Look up the Pages the token was granted (debug_token) one by one.
      // With "all Pages" access there is no list of ids, so FB_EXTRA_PAGE_IDS names them instead.
      const ids = new Set([...(await this.grantedPageIds()), ...extraPageIds(this.cfg)]);
      for (const pageId of ids) {
        if (map.has(pageId)) continue;
        const p = await this.lookupPage(pageId);
        if (p) map.set(p.id, p);
      }
    }
    if (this.cfg.FB_PAGE_ACCESS_TOKEN && this.cfg.FB_PAGE_ID && !map.has(this.cfg.FB_PAGE_ID)) {
      const res = await this.request('GET', this.cfg.FB_PAGE_ID, this.cfg.FB_PAGE_ACCESS_TOKEN, { fields: 'id,name' });
      map.set(res.id, { id: res.id, name: res.name, access_token: this.cfg.FB_PAGE_ACCESS_TOKEN });
    }
    this.pages = map;
    return [...map.values()];
  }

  /** A Page the user can manage, found by id. Meta only returns its access_token to people who manage it. */
  private async lookupPage(pageId: string): Promise<PageInfo | undefined> {
    try {
      const p = await this.request('GET', pageId, this.cfg.FB_USER_ACCESS_TOKEN!, { fields: 'id,name,access_token' });
      return p.access_token ? { id: p.id, name: p.name, access_token: p.access_token } : undefined;
    } catch (err) {
      if (err instanceof GraphError && err.code !== undefined) return undefined; // not found / no access
      throw err; // network, timeout, rate limit
    }
  }

  /** Page ids the user token was granted pages_show_list for (empty when it covers all Pages). */
  private async grantedPageIds(): Promise<string[]> {
    const token = this.cfg.FB_USER_ACCESS_TOKEN!;
    const res = await this.request('GET', 'debug_token', token, { input_token: token });
    const scope = (res.data?.granular_scopes ?? []).find((g: any) => g.scope === 'pages_show_list');
    return (scope?.target_ids ?? []).filter((id: unknown) => typeof id === 'string' && /^\d+$/.test(id));
  }

  /** Which required permissions the user token has. Undefined for a Page-only token (no user to ask). */
  async checkPermissions(): Promise<{ granted: string[]; missing: string[] } | undefined> {
    if (!this.cfg.FB_USER_ACCESS_TOKEN) return undefined;
    const res = await this.request('GET', 'me/permissions', this.cfg.FB_USER_ACCESS_TOKEN, { limit: 100 });
    const granted: string[] = (res.data ?? []).filter((p: any) => p.status === 'granted').map((p: any) => p.permission);
    return { granted, missing: REQUIRED_PERMISSIONS.filter((p) => !granted.includes(p)) };
  }

  /** Authorization check: the page must be one this token manages. */
  async pageToken(pageId: string): Promise<string> {
    let page = (await this.listPages()).find((p) => p.id === pageId);
    // A wrong id must not cost a full page-list refresh + lookup on every call.
    const missedAt = this.missing.get(pageId);
    const cooling = missedAt !== undefined && Date.now() - missedAt < this.cfg.FB_PAGES_REFRESH_COOLDOWN_SEC * 1000;
    if (!page && !cooling) {
      page = (await this.listPages(true)).find((p) => p.id === pageId);
      if (!page && this.cfg.FB_USER_ACCESS_TOKEN && /^\d+$/.test(pageId)) {
        page = await this.lookupPage(pageId);
        if (page) this.pages?.set(page.id, page);
      }
      if (page) this.missing.delete(pageId);
      else this.missing.set(pageId, Date.now());
    }
    if (!page) throw new GraphError(`Page ${pageId} is not managed by this token. Use fb_list_pages to see allowed pages.`);
    return page.access_token;
  }

  async get(pageId: string, path: string, params?: Params) {
    return this.request('GET', path, await this.pageToken(pageId), params);
  }

  async post(pageId: string, path: string, params?: Params, form?: FormData) {
    // Messenger stays off until the owner turns it on (FB_MESSENGER_LIVE=true): no message, bot or by hand, before that.
    if (/\/messages$/.test(path) && !this.cfg.FB_MESSENGER_LIVE) {
      throw new Error('Messenger sending is off (owner rule: not live until our wording is checked against Meta standards). Set FB_MESSENGER_LIVE=true in .env only with the owner OK.');
    }
    // Community Standards guard: nothing that reads like phishing or a credit scam reaches Facebook.
    assertSafeContent(params as Record<string, unknown> | undefined);
    if (form) assertSafeContent(Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string')));
    return this.request('POST', path, await this.pageToken(pageId), params, form);
  }

  async del(pageId: string, path: string) {
    return this.request('DELETE', path, await this.pageToken(pageId));
  }
}
