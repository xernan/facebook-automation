// `npm run login`: opens Facebook Login in the browser, asks for every permission the tools need,
// turns the result into a long-lived token and saves it to .env. Never prints the token.
// `npm run login -- --no-leads` skips the Lead Ads permissions (for apps without a Lead Ads use case).
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig, type Config } from './config.js';
import { ROOT_DIR } from './context.js';
import { exchangeCode, buildLoginUrl, setEnvValue } from './oauth.js';
import { redact } from './redact.js';

const ENV_FILE = path.join(ROOT_DIR, '.env');

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' }).unref();
}

/** App id from .env, or from the current token (debug_token) when it is blank. */
async function findAppId(cfg: Config): Promise<string> {
  if (cfg.FB_APP_ID) return cfg.FB_APP_ID;
  const token = cfg.FB_USER_ACCESS_TOKEN;
  if (token) {
    const q = new URLSearchParams({ input_token: token, access_token: token });
    if (cfg.FB_APP_SECRET) q.set('appsecret_proof', createHmac('sha256', cfg.FB_APP_SECRET).update(token).digest('hex'));
    const url = `https://graph.facebook.com/${cfg.FB_GRAPH_VERSION}/debug_token?${q}`;
    const json: any = await fetch(url).then((r) => r.json()).catch(() => ({}));
    if (json.data?.app_id) return String(json.data.app_id);
  }
  throw new Error('Set FB_APP_ID in .env (App settings -> Basic -> App ID).');
}

function page(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Facebook login</title><p style="font:16px sans-serif">${message}</p>`);
}

async function main() {
  dotenv.config({ path: ENV_FILE, quiet: true });
  const cfg = loadConfig(process.env, ROOT_DIR, { requireToken: false });
  const appId = await findAppId(cfg);
  const redirectUri = `http://localhost:${cfg.FB_LOGIN_PORT}/callback`;
  const state = randomBytes(16).toString('hex');
  const secrets = () => [cfg.FB_APP_SECRET];

  const token = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Login timed out. Run npm run login again.')), cfg.FB_LOGIN_TIMEOUT_MIN * 60_000);
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== '/callback') return page(res, 404, 'Not found.');
      if (url.searchParams.get('state') !== state) return page(res, 400, 'This login link is old. Run npm run login again.');
      const code = url.searchParams.get('code');
      if (!code) {
        page(res, 400, 'Login was cancelled. You can close this tab.');
        return finish(new Error(`Login cancelled: ${url.searchParams.get('error_description') ?? 'no code'}`));
      }
      try {
        const t = await exchangeCode(cfg, appId, code, redirectUri);
        page(res, 200, 'Done. You can close this tab and go back to Claude.');
        finish(undefined, t);
      } catch (err) {
        page(res, 500, 'Login failed. Check the terminal.');
        finish(err as Error);
      }
    });
    function finish(err?: Error, t?: string) {
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve(t!);
    }
    server.on('error', (err) => finish(new Error(`Port ${cfg.FB_LOGIN_PORT} is busy. Set FB_LOGIN_PORT in .env. (${err.message})`)));
    // Loopback only: nothing outside this computer can reach the callback.
    server.listen(cfg.FB_LOGIN_PORT, '127.0.0.1', () => {
      const loginUrl = buildLoginUrl(cfg, appId, redirectUri, state, { leads: !process.argv.includes('--no-leads') });
      console.log('Opening Facebook Login in your browser.');
      console.log('Tick your Page(s) and allow every permission. If the browser did not open, go to:');
      console.log(loginUrl);
      openBrowser(loginUrl);
    });
  }).catch((err: Error) => {
    throw new Error(redact(err.message, secrets()));
  });

  let text = await fs.readFile(ENV_FILE, 'utf8').catch(() => '');
  text = setEnvValue(text, 'FB_USER_ACCESS_TOKEN', token);
  text = setEnvValue(text, 'FB_APP_ID', appId);
  await fs.writeFile(ENV_FILE, text, 'utf8');
  console.log('Saved the new token to .env. Now run: npm run doctor');
}

main().catch((err) => {
  console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
