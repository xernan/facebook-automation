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
  if (code === 100 && subcode === 33) return `Object not found, or this token cannot see it. (${raw})`;
  return raw;
}

export interface PageInfo {
  id: string;
  name: string;
  access_token: string;
  tasks?: string[];
}

export class GraphClient {
  private readonly readLimiter: RateLimiter;
  private readonly writeLimiter: RateLimiter;
  private pages: Map<string, PageInfo> | undefined;

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

    let res: Response;
    try {
      res = await this.fetchFn(url, { method, body, signal: AbortSignal.timeout(this.cfg.FB_HTTP_TIMEOUT_MS) });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new GraphError('Request timed out. Try again.');
      throw new GraphError('No internet connection');
    }

    const text = await res.text();
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
    }
    if (this.cfg.FB_PAGE_ACCESS_TOKEN && this.cfg.FB_PAGE_ID && !map.has(this.cfg.FB_PAGE_ID)) {
      const res = await this.request('GET', this.cfg.FB_PAGE_ID, this.cfg.FB_PAGE_ACCESS_TOKEN, { fields: 'id,name' });
      map.set(res.id, { id: res.id, name: res.name, access_token: this.cfg.FB_PAGE_ACCESS_TOKEN });
    }
    this.pages = map;
    return [...map.values()];
  }

  /** Authorization check: the page must be one this token manages. */
  async pageToken(pageId: string): Promise<string> {
    let page = (await this.listPages()).find((p) => p.id === pageId);
    if (!page) page = (await this.listPages(true)).find((p) => p.id === pageId);
    if (!page) throw new GraphError(`Page ${pageId} is not managed by this token. Use fb_list_pages to see allowed pages.`);
    return page.access_token;
  }

  async get(pageId: string, path: string, params?: Params) {
    return this.request('GET', path, await this.pageToken(pageId), params);
  }

  async post(pageId: string, path: string, params?: Params, form?: FormData) {
    return this.request('POST', path, await this.pageToken(pageId), params, form);
  }

  async del(pageId: string, path: string) {
    return this.request('DELETE', path, await this.pageToken(pageId));
  }
}
