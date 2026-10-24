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
import { listApplicants, loadSettings, saveSettings, writeClientsXlsx } from './leadout.js';
import { findAcrobat, listPrinters, printPdf } from './printer.js';
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
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:12px}
tr.row{cursor:pointer}tr.row:hover{background:#f0f4fa}.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600}
.ok{background:#e3f4e8;color:var(--ok)}.warn{background:#fff1dc;color:var(--warn)}.muted{color:var(--muted)}
button.btn{background:var(--accent);color:#fff;border:0;border-radius:7px;padding:7px 12px;font:inherit;cursor:pointer}button.btn.sec{background:#e8edf3;color:var(--ink)}
.row2{display:flex;gap:12px;flex-wrap:wrap;align-items:center}label{display:block;font-size:12px;color:var(--muted);margin:8px 0 3px}
input,select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;min-width:220px}ul{margin:6px 0;padding-left:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}#msg{position:fixed;bottom:16px;right:16px;background:#14181f;color:#fff;padding:10px 14px;border-radius:8px;display:none}
.stats{display:flex;gap:10px;flex-wrap:wrap}.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:120px}.stat b{font-size:20px;display:block}
</style></head><body>
<header><b>CARD MAX</b><nav><button data-v="list" class="on">Applicants</button><button data-v="settings">Settings</button></nav><span class="muted" style="margin-left:auto;color:#9fb0c6">This PC only</span></header>
<main id="app">Loading…</main><div id="msg"></div>
<script>
const TOKEN=${JSON.stringify(token)};let S=null,view='list',open=null;
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const msg=t=>{const m=$('#msg');m.textContent=t;m.style.display='block';setTimeout(()=>m.style.display='none',3500)};
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-token':TOKEN},body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Something went wrong');return j}
async function load(){S=await (await fetch('/api/state')).json();render()}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{view=b.dataset.v;open=null;document.querySelectorAll('nav button').forEach(x=>x.classList.toggle('on',x===b));render()});
const file=(f,n)=>'/file?folder='+encodeURIComponent(f)+'&name='+encodeURIComponent(n);
function render(){const a=$('#app');if(view==='settings')return renderSettings(a);if(open)return renderOne(a);
const rows=S.applicants;
a.innerHTML='<div class="stats"><div class="stat"><b>'+rows.length+'</b>Applicants</div><div class="stat"><b>'+rows.filter(r=>r.printed).length+'</b>Printed</div><div class="stat"><b>'+(S.flow.waiting||0)+'</b>In chat now</div></div><br>'+
'<div class="card"><table><tr><th>Completed</th><th>Name</th><th>Mobile</th><th>PDFs</th><th>Flags</th><th>To check</th><th>Printed</th></tr>'+
(rows.length?rows.map((r,i)=>'<tr class="row" data-i="'+i+'"><td>'+esc(r.completed_at.slice(0,16).replace('T',' '))+'</td><td><b>'+esc(r.name||'(no name yet)')+'</b></td><td>'+esc(r.mobile)+'</td><td>'+esc(r.banks_with_pdf)+'</td><td>'+(r.flags?'<span class="pill warn">'+esc(r.flags)+'</span>':'')+'</td><td>'+r.missing_list.length+' item(s)</td><td>'+(r.printed?'<span class="pill ok">Yes</span>':'<span class="pill warn">No</span>')+'</td></tr>').join(''):'<tr><td colspan="7" class="muted">No applicants yet. Finished Messenger applications show up here.</td></tr>')+'</table></div>';
a.querySelectorAll('tr.row').forEach(t=>t.onclick=()=>{open=rows[+t.dataset.i];render()})}
function renderOne(a){const r=open;a.innerHTML='<p><button class="btn sec" id="back">← All applicants</button></p><div class="card"><div class="row2"><h2 style="margin:0">'+esc(r.name||'(no name yet)')+'</h2><span class="muted">'+esc(r.mobile)+' · '+esc(r.email)+'</span><span style="margin-left:auto" class="row2"><button class="btn" id="pall">Print all</button><button class="btn sec" id="mark">'+(r.printed?'Mark not printed':'Mark printed')+'</button></span></div>'+
'<p class="muted">Has cards: '+esc(r.existing_cards)+(r.flags?' · <span class="pill warn">'+esc(r.flags)+'</span>':'')+'</p></div>'+
'<div class="grid"><div class="card"><b>Files</b><ul>'+r.files.map(f=>'<li><a href="'+file(r.folder,f)+'" target="_blank">'+esc(f)+'</a>'+(f.toLowerCase().endsWith('.pdf')?' <button class="btn sec" data-p="'+esc(f)+'">Print</button>':'')+'</li>').join('')+'</ul></div>'+
'<div class="card"><b>To check before submitting</b><ul>'+r.missing_list.map(m=>'<li>'+esc(m)+'</li>').join('')+'</ul><b>Defaults used</b><ul>'+r.defaults_list.map(m=>'<li class="muted">'+esc(m)+'</li>').join('')+'</ul></div></div>';
$('#back').onclick=()=>{open=null;render()};
$('#pall').onclick=async()=>{try{await post('/api/print',{folder:r.folder});msg('Sent to the printer');load()}catch(e){msg(e.message)}};
$('#mark').onclick=async()=>{await post('/api/printed',{folder:r.folder,printed:!r.printed});r.printed=!r.printed;msg('Saved');load()};
a.querySelectorAll('[data-p]').forEach(b=>b.onclick=async()=>{try{await post('/api/print',{folder:r.folder,name:b.dataset.p});msg('Sent to the printer')}catch(e){msg(e.message)}})}
function renderSettings(a){const s=S.settings,o=S.cardOptions;const sel=(id,opts,val)=>'<select id="'+id+'"><option value="">(none)</option>'+opts.map(x=>'<option'+(x===val?' selected':'')+'>'+esc(x)+'</option>').join('')+'</select>';
a.innerHTML='<div class="card"><h3 style="margin-top:0">Agent</h3><label>Agent name</label><input id="agent_name" value="'+esc(s.agent_name)+'"><label>Agent code</label><input id="agent_code" value="'+esc(s.agent_code)+'"></div>'+
'<div class="card"><h3 style="margin-top:0">Card to apply for (per bank)</h3><div class="row2"><div><label>Metrobank</label>'+sel('cc_metrobank',o.metrobank||[],s.card_choice.metrobank)+'</div><div><label>EastWest</label>'+sel('cc_eastwest',o.eastwest||[],s.card_choice.eastwest)+'</div><div><label>China Bank</label>'+sel('cc_chinabank',o.chinabank||[],s.card_choice.chinabank)+'</div></div></div>'+
'<div class="card"><h3 style="margin-top:0">Printing</h3><label>Printer</label>'+sel('printer',S.printers,s.printer)+'<label><input type="checkbox" id="auto_print" style="min-width:0"'+(s.auto_print?' checked':'')+'> Print new complete applications automatically (PC must be on)</label>'+(S.acrobat?'':'<p class="pill warn">Adobe Acrobat not found: printing will not work</p>')+'</div>'+
'<div class="card"><h3 style="margin-top:0">Text on the forms</h3><div class="row2"><div><label>Answer size (pt, 0 = fit each box)</label><input id="text_uniform_size" type="number" step="0.5" min="0" max="20" value="'+s.text_uniform_size+'"></div><div><label><input type="checkbox" id="text_bold" style="min-width:0"'+(s.text_bold?' checked':'')+'> Bold</label></div></div></div>'+
'<button class="btn" id="save">Save settings</button>';
$('#save').onclick=async()=>{const v=id=>$('#'+id).value;const body={...s,agent_name:v('agent_name'),agent_code:v('agent_code'),printer:v('printer'),auto_print:$('#auto_print').checked,text_bold:$('#text_bold').checked,text_uniform_size:Number(v('text_uniform_size')),card_choice:Object.fromEntries(['metrobank','eastwest','chinabank'].map(b=>[b,v('cc_'+b)]).filter(([,x])=>x))};
try{await post('/api/settings',body);msg('Settings saved');load()}catch(e){msg(e.message)}}}
load();setInterval(()=>{if(view==='list'&&!open)load()},15000);
</script></body></html>`;
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
