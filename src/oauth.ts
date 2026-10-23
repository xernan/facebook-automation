import type { Config } from './config.js';
import { LEAD_PERMISSIONS, REQUIRED_PERMISSIONS } from './graph.js';

type FetchFn = typeof fetch;

/** Facebook Login dialog asking for every permission the tools need (leads: false skips the Lead Ads ones). */
export function buildLoginUrl(cfg: Config, appId: string, redirectUri: string, state: string, { leads = true } = {}): string {
  const q = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    scope: REQUIRED_PERMISSIONS.filter((p) => leads || !LEAD_PERMISSIONS.includes(p)).join(','),
    // Shows the permission and Page choices again even if some were declined before.
    auth_type: 'rerequest',
  });
  return `https://www.facebook.com/${cfg.FB_GRAPH_VERSION}/dialog/oauth?${q}`;
}

async function getToken(cfg: Config, params: Record<string, string>, fetchFn: FetchFn): Promise<string> {
  const url = `https://graph.facebook.com/${cfg.FB_GRAPH_VERSION}/oauth/access_token?${new URLSearchParams(params)}`;
  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(cfg.FB_HTTP_TIMEOUT_MS) });
  } catch {
    throw new Error('No internet connection');
  }
  const json: any = await res.json().catch(() => ({}));
  // Only Meta's message is passed on; the response may hold a token, so never echo it whole.
  if (!res.ok || !json.access_token) throw new Error(`Login failed: ${json.error?.message ?? `HTTP ${res.status}`}`);
  return json.access_token;
}

/** Code from the login redirect -> short-lived token -> long-lived (about 60 days) user token. */
export async function exchangeCode(
  cfg: Config,
  appId: string,
  code: string,
  redirectUri: string,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  const secret = cfg.FB_APP_SECRET;
  if (!secret) throw new Error('FB_APP_SECRET is needed in .env for login.');
  const short = await getToken(cfg, { client_id: appId, client_secret: secret, redirect_uri: redirectUri, code }, fetchFn);
  return getToken(
    cfg,
    { grant_type: 'fb_exchange_token', client_id: appId, client_secret: secret, fb_exchange_token: short },
    fetchFn,
  );
}

/** Sets KEY=value in .env text, keeping every other line (and line endings) as is. */
export function setEnvValue(text: string, key: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('Value must be one line.');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const re = new RegExp(`^${key}[ \\t]*=.*$`, 'm');
  if (re.test(text)) return text.replace(re, () => `${key}=${value}`);
  return `${text}${text === '' || text.endsWith('\n') ? '' : eol}${key}=${value}${eol}`;
}
