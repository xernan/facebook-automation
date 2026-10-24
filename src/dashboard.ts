#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { settingsSchema } from './application.js';
import { ROOT_DIR } from './context.js';
import { loadConfig } from './config.js';
import { FlowStore } from './flowstore.js';
import { listApplicants, loadSettings, saveForm, saveSettings, writeClientsXlsx } from './leadout.js';
import { findAcrobat, listPrinters, printPdf } from './printer.js';
import { forgetPhone, loadPhonebook, lookupPhone } from './phonebook.js';
import dotenv from 'dotenv';

// Local dashboard (this PC only, 127.0.0.1): applicants, their PDFs/IDs and missing items, print, and settings.
// Personal data never leaves this computer. Every change needs the page's token and a localhost Host header,
// so another website cannot drive it from the owner's browser.

const BANK_FILES = ['metrobank', 'eastwest', 'chinabank'] as const;

export async function cardOptions(templatesDir: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const bank of BANK_FILES) {
    try {
      const pdf = await PDFDocument.load(await fs.readFile(path.join(templatesDir, `${bank}.pdf`)));
      out[bank] = [
        ...new Set(
          pdf
            .getForm()
            .getFields()
            .map((f) => /^bank_only__card_(?:choice|variant)__checkbox__([a-z0-9]+)/.exec(f.getName())?.[1])
            .filter((x): x is string => !!x),
        ),
      ];
    } catch {
      out[bank] = [];
    }
  }
  return out;
}

/** A file inside one applicant folder, or undefined if the request tries to leave it. */
export function safeFile(flowDir: string, folder: string, name: string): string | undefined {
  // Plain names only: no separators or dot-dot, so a file can only come from the folder that was asked for.
  const plain = (s: string) => !!s && s !== '.' && s !== '..' && !/[\\/]/.test(s) && path.basename(s) === s;
  if (!plain(folder) || !plain(name)) return undefined;
  const root = path.resolve(flowDir, 'applicants');
  const full = path.resolve(root, folder, name);
  if (!full.startsWith(root + path.sep) || path.dirname(path.dirname(full)) !== root) return undefined;
  return full;
}

const TYPES: Record<string, string> = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

async function setPrinted(flowDir: string, folder: string, printed: boolean) {
  const file = safeFile(flowDir, folder, 'details.json');
  if (!file) throw new Error('Unknown applicant.');
  const d = JSON.parse(await fs.readFile(file, 'utf8'));
  d.printed = printed;
  d.printed_at = printed ? new Date().toISOString() : undefined;
  await fs.writeFile(file, JSON.stringify(d, null, 2), 'utf8');
  await writeClientsXlsx(flowDir).catch(() => undefined);
}

/** Prints every PDF in an applicant folder (bank forms, then the ID sheet). */
export async function printApplicant(flowDir: string, folder: string, printer: string, only?: string): Promise<string[]> {
  const dir = safeFile(flowDir, folder, 'details.json');
  if (!dir) throw new Error('Unknown applicant.');
  const files = (await fs.readdir(path.dirname(dir))).filter((f) => f.toLowerCase().endsWith('.pdf') && (!only || f === only));
  if (files.length === 0) throw new Error('No PDF to print.');
  files.sort((a, b) => Number(a.startsWith('ID')) - Number(b.startsWith('ID')) || a.localeCompare(b));
  for (const f of files) {
    await printPdf(path.join(path.dirname(dir), f), printer);
    await new Promise((r) => setTimeout(r, 4000)); // Acrobat handles one file at a time
  }
  if (!only) await setPrinted(flowDir, folder, true);
  return files;
}

function page(token: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CARD MAX Applicants</title><style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#14181f;--muted:#5b6472;--line:#e3e6eb;--accent:#0b5cad;--ok:#1d7a3a;--warn:#a15c00;--bad:#b42318}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,Segoe UI,Arial;background:var(--bg);color:var(--ink)}
header{background:#0f1b2d;color:#fff;padding:12px 20px;display:flex;gap:16px;align-items:center}header b{font-size:16px}
nav button{background:none;border:0;color:#cfd8e3;font:inherit;padding:6px 10px;cursor:pointer;border-radius:6px}nav button.on{background:#25344d;color:#fff}
main{padding:16px 20px;max-width:1200px;margin:auto}.card{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px}
.card h3{margin:0 0 6px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:12px}
tr.row{cursor:pointer}tr.row:hover{background:#f0f4fa}.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600}
.ok{background:#e3f4e8;color:var(--ok)}.warn{background:#fff1dc;color:var(--warn)}.muted{color:var(--muted)}
button.btn{background:var(--accent);color:#fff;border:0;border-radius:7px;padding:7px 12px;font:inherit;cursor:pointer}button.btn.sec{background:#e8edf3;color:var(--ink)}
.row2{display:flex;gap:12px;flex-wrap:wrap;align-items:center}label{display:block;font-size:12px;color:var(--muted);margin:8px 0 3px}
input,select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;min-width:0;width:100%}ul{margin:6px 0;padding-left:18px}
.fgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:4px 14px}
.missing{border-color:var(--bad);background:#fff5f4}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}#msg{position:fixed;bottom:16px;right:16px;background:#14181f;color:#fff;padding:10px 14px;border-radius:8px;display:none;max-width:420px}
.stats{display:flex;gap:10px;flex-wrap:wrap}.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:120px}.stat b{font-size:20px;display:block}
</style></head><body>
<header><b>CARD MAX</b><nav><button data-v="list" class="on">Applicants</button><button data-v="settings">Settings</button></nav><span class="muted" style="margin-left:auto;color:#9fb0c6">This PC only</span></header>
<main id="app">Loading…</main><div id="msg"></div>
<script>window.TOKEN=${JSON.stringify(token)};</script><script src="/app.js"></script></body></html>`;
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100_000) throw new Error('Too large.');
  }
  return body ? JSON.parse(body) : {};
}

export function createDashboard(opts: { flowDir: string; templatesDir: string; port: number; token?: string }) {
  const token = opts.token ?? randomBytes(24).toString('hex');
  const hosts = new Set([`localhost:${opts.port}`, `127.0.0.1:${opts.port}`]);
  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      // DNS-rebinding guard: only answer to this PC's own address.
      if (!hosts.has(req.headers.host ?? '')) return send(403, { error: 'Forbidden' });
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/') return send(200, page(token), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/app.js') {
        return send(200, await fs.readFile(path.join(ROOT_DIR, 'public', 'dashboard.js')), 'text/javascript; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/address') {
        const [address, lists] = await Promise.all([
          fs.readFile(path.join(ROOT_DIR, 'data', 'ph-address.json'), 'utf8'),
          fs.readFile(path.join(ROOT_DIR, 'data', 'ph-lists.json'), 'utf8'),
        ]);
        return send(200, `{"address":${address},"lists":${lists}}`);
      }
      if (req.method === 'GET' && url.pathname === '/api/form') {
        const file = safeFile(opts.flowDir, url.searchParams.get('folder') ?? '', 'details.json');
        if (!file) return send(404, { error: 'Unknown applicant.' });
        const d = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!d.form) return send(400, { error: 'This applicant was saved before the Default Form existed.' });
        return send(200, { form: d.form, missing: d.missing ?? [] });
      }
      if (req.method === 'GET' && url.pathname === '/api/phone') {
        const hit = await lookupPhone(opts.flowDir, url.searchParams.get('employer')?.slice(0, 120), url.searchParams.get('city')?.slice(0, 100));
        return send(200, hit ? { phone: hit.phone, source: hit.source } : {});
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const rows = await listApplicants(opts.flowDir);
        const applicants = [];
        for (const r of rows) {
          const dir = path.join(opts.flowDir, 'applicants', r.folder);
          const d = JSON.parse(await fs.readFile(path.join(dir, 'details.json'), 'utf8'));
          applicants.push({ ...r, files: (await fs.readdir(dir)).filter((f) => /\.(pdf|jpe?g|png|webp)$/i.test(f)), missing_list: d.missing ?? [], defaults_list: d.defaults ?? [] });
        }
        const state = await new FlowStore(opts.flowDir).load(new Date());
        const waiting = Object.values(state.people).filter((p) => !['done', 'declined', 'rejected', 'excluded'].includes(p.stage)).length;
        return send(200, {
          applicants,
          flow: { waiting },
          settings: await loadSettings(opts.flowDir),
          printers: await listPrinters().catch(() => []),
          cardOptions: await cardOptions(opts.templatesDir),
          acrobat: !!findAcrobat(),
          phonebook: await loadPhonebook(opts.flowDir).catch(() => []),
        });
      }
      if (req.method === 'GET' && url.pathname === '/file') {
        const full = safeFile(opts.flowDir, url.searchParams.get('folder') ?? '', url.searchParams.get('name') ?? '');
        const type = full && TYPES[path.extname(full).toLowerCase()];
        if (!full || !type) return send(404, { error: 'Not found' });
        return send(200, await fs.readFile(full), type);
      }
      if (req.method === 'POST') {
        if (req.headers['x-token'] !== token) return send(403, { error: 'Forbidden' });
        const body = await readJson(req);
        if (url.pathname === '/api/settings') {
          await saveSettings(opts.flowDir, settingsSchema.parse(body));
          return send(200, { ok: true });
        }
        if (url.pathname === '/api/form') {
          const folder = String(body.folder ?? '');
          if (!safeFile(opts.flowDir, folder, 'details.json')) return send(404, { error: 'Unknown applicant.' });
          return send(200, await saveForm(opts.flowDir, opts.templatesDir, folder, body.form));
        }
        if (url.pathname === '/api/phonebook/remove') {
          const ok = await forgetPhone(opts.flowDir, String(body.company ?? ''), String(body.city ?? ''));
          return ok ? send(200, { ok: true }) : send(404, { error: 'Not found' });
        }
        if (url.pathname === '/api/printed') {
          await setPrinted(opts.flowDir, String(body.folder ?? ''), body.printed === true);
          return send(200, { ok: true });
        }
        if (url.pathname === '/api/print') {
          const s = await loadSettings(opts.flowDir);
          const files = await printApplicant(opts.flowDir, String(body.folder ?? ''), s.printer, body.name ? String(body.name) : undefined);
          return send(200, { ok: true, files });
        }
      }
      return send(404, { error: 'Not found' });
    } catch (err) {
      return send(400, { error: err instanceof Error ? err.message : 'Something went wrong' });
    }
  });
  return { server, token };
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('dist', 'dashboard.js'))) {
  dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });
  const cfg = loadConfig(process.env, ROOT_DIR, { requireToken: false });
  const { server } = createDashboard({ flowDir: cfg.flowDir, templatesDir: cfg.templatesDir, port: cfg.FB_DASHBOARD_PORT });
  server.listen(cfg.FB_DASHBOARD_PORT, '127.0.0.1', () => console.error(`Dashboard: http://localhost:${cfg.FB_DASHBOARD_PORT}`));
}
