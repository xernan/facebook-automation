import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDashboard, safeFile } from '../src/dashboard.js';

const servers: { close: () => void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function start() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dash-'));
  const folder = '2026-10-25 Juan Dela Cruz';
  mkdirSync(path.join(dir, 'applicants', folder), { recursive: true });
  writeFileSync(
    path.join(dir, 'applicants', folder, 'details.json'),
    JSON.stringify({ completed_at: '2026-10-25T13:00:00Z', data: { full_name: 'Juan Dela Cruz', mobile: '0917' }, missing: ['TIN'], defaults: [], printed: false }),
  );
  writeFileSync(path.join(dir, 'applicants', folder, 'EastWest.pdf'), '%PDF-1.4 test');
  // Port 0 first to learn a free port, then the dashboard checks Host against it.
  const probe = createDashboard({ flowDir: dir, templatesDir: dir, port: 0 });
  await new Promise<void>((r) => probe.server.listen(0, '127.0.0.1', r));
  const port = (probe.server.address() as AddressInfo).port;
  probe.server.close();
  const d = createDashboard({ flowDir: dir, templatesDir: dir, port, token: 'tok' });
  await new Promise<void>((r) => d.server.listen(port, '127.0.0.1', r));
  servers.push(d.server);
  const base = `http://127.0.0.1:${port}`;
  return { dir, folder, base };
}

describe('dashboard', () => {
  it('office number lookup from the directory; removing needs the token', async () => {
    const { base, dir } = await start();
    const { rememberPhone } = await import('../src/phonebook.js');
    await rememberPhone(dir, { company: 'Jollibee', city: 'Muntinlupa', phone: '(02) 8123-0000', source: 'https://example.com/x' });
    expect(await (await fetch(`${base}/api/phone?employer=Jollibee%20Alabang&city=Muntinlupa`)).json()).toEqual({ phone: '(02) 8123-0000', source: 'https://example.com/x' });
    expect(await (await fetch(`${base}/api/phone?employer=Jollibee&city=Cebu`)).json()).toEqual({});
    expect((await (await fetch(`${base}/api/state`)).json()).phonebook).toHaveLength(1);
    const body = JSON.stringify({ company: 'Jollibee', city: 'Muntinlupa' });
    expect((await fetch(`${base}/api/phonebook/remove`, { method: 'POST', body })).status).toBe(403);
    expect((await fetch(`${base}/api/phonebook/remove`, { method: 'POST', headers: { 'x-token': 'tok' }, body })).status).toBe(200);
    expect((await (await fetch(`${base}/api/state`)).json()).phonebook).toHaveLength(0);
  });

  it('lists applicants with their missing items and files', async () => {
    const { base } = await start();
    const s = await (await fetch(`${base}/api/state`)).json();
    expect(s.applicants).toHaveLength(1);
    expect(s.applicants[0].name).toBe('Juan Dela Cruz');
    expect(s.applicants[0].missing_list).toEqual(['TIN']);
    expect(s.applicants[0].files).toEqual(['EastWest.pdf']);
    // Weekly stats with the default quota; the 2026-10-25 applicant is in an earlier week or month.
    expect(s.stats.this_week.quota).toBe(10);
    expect([s.stats.current_month, ...s.stats.archive].flatMap((m: any) => m.weeks.flatMap((w: any) => w.folders))).toContain('2026-10-25 Juan Dela Cruz');
  });

  it('bank result needs the token; marketing shows it; draft check uses the guard', async () => {
    const { base, folder } = await start();
    const body = JSON.stringify({ folder, result: 'Approved', card: 'EastWest Platinum', proof_ok: true });
    expect((await fetch(`${base}/api/outcome`, { method: 'POST', body })).status).toBe(403);
    expect((await fetch(`${base}/api/outcome`, { method: 'POST', body: JSON.stringify({ folder: '..', result: 'Approved' }), headers: { 'x-token': 'tok' } })).status).toBe(404);
    expect((await fetch(`${base}/api/outcome`, { method: 'POST', body, headers: { 'x-token': 'tok' } })).status).toBe(200);
    const s = await (await fetch(`${base}/api/state`)).json();
    expect(s.applicants[0]).toMatchObject({ result: 'Approved', approved_card: 'EastWest Platinum', proof_ok: true });
    const m = await (await fetch(`${base}/api/marketing`)).json();
    expect(m.counts).toEqual({ pending: 0, approved: 1, declined: 0 });
    expect(m.proof[0].draft).toContain('J.!');
    expect(m.page).toEqual({ configured: false });
    const chk = (text: string) => fetch(`${base}/api/check`, { method: 'POST', body: JSON.stringify({ text }), headers: { 'x-token': 'tok' } }).then((r) => r.json());
    expect((await chk('Comment YES kung gusto mo')).problem).toMatch(/engagement bait/);
    expect((await chk('Alin ang mas gusto mo: miles o cashback?')).problem).toBeNull();
  });

  it('the dashboard page script has no syntax errors', async () => {
    const { Script } = await import('node:vm');
    expect(() => new Script(readFileSync('public/dashboard.js', 'utf8'))).not.toThrow();
  });

  it('test mode is on by default, changes need the token, bad ids are refused', async () => {
    const { base } = await start();
    expect((await (await fetch(`${base}/api/state`)).json()).testMode).toEqual({ on: true, ids: [] });
    const body = (b: unknown) => ({ method: 'POST', body: JSON.stringify(b), headers: { 'x-token': 'tok' } });
    expect((await fetch(`${base}/api/testmode`, { method: 'POST', body: JSON.stringify({ on: false }) })).status).toBe(403);
    expect((await fetch(`${base}/api/testmode`, body({ on: true, ids: ['12345', 'x'] }))).status).toBe(400);
    expect((await fetch(`${base}/api/testmode`, body({ on: true, ids: ['12345', '12345'] }))).status).toBe(200);
    expect((await (await fetch(`${base}/api/state`)).json()).testMode).toEqual({ on: true, ids: ['12345'] });
  });

  it('serves files only from inside an applicant folder', async () => {
    const { base, folder } = await start();
    expect((await fetch(`${base}/file?folder=${encodeURIComponent(folder)}&name=EastWest.pdf`)).status).toBe(200);
    expect((await fetch(`${base}/file?folder=..&name=.env`)).status).toBe(404);
    expect((await fetch(`${base}/file?folder=${encodeURIComponent(folder)}&name=details.json`)).status).toBe(404);
  });

  it('changes need the page token (another website cannot post here)', async () => {
    const { base, dir } = await start();
    const body = JSON.stringify({ agent_name: 'X' });
    expect((await fetch(`${base}/api/settings`, { method: 'POST', body })).status).toBe(403);
    expect((await fetch(`${base}/api/settings`, { method: 'POST', body, headers: { 'x-token': 'bad' } })).status).toBe(403);
    const ok = await fetch(`${base}/api/settings`, { method: 'POST', body, headers: { 'x-token': 'tok' } });
    expect(ok.status).toBe(200);
    expect(JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')).agent_name).toBe('X');
  });

  it('refuses other Host names (DNS rebinding)', async () => {
    const { base } = await start();
    const http = await import('node:http');
    const url = new URL(base);
    const status = await new Promise<number>((resolve) =>
      http.get({ host: url.hostname, port: url.port, path: '/api/state', headers: { host: 'evil.example.com' } }, (r) => resolve(r.statusCode!)),
    );
    expect(status).toBe(403);
  });

  it('marks printed and rejects bad settings', async () => {
    const { base, dir, folder } = await start();
    const r = await fetch(`${base}/api/printed`, { method: 'POST', body: JSON.stringify({ folder, printed: true }), headers: { 'x-token': 'tok' } });
    expect(r.status).toBe(200);
    expect(JSON.parse(readFileSync(path.join(dir, 'applicants', folder, 'details.json'), 'utf8')).printed).toBe(true);
    const bad = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ text_uniform_size: 99 }), headers: { 'x-token': 'tok' } });
    expect(bad.status).toBe(400);
  });

  it('safeFile stays inside applicants/<folder>/', () => {
    const d = '/data';
    expect(safeFile(d, 'A', 'x.pdf')).toBe(path.resolve(d, 'applicants', 'A', 'x.pdf'));
    expect(safeFile(d, 'A', '../B/x.pdf')).toBeUndefined();
    expect(safeFile(d, '..', 'state.json')).toBeUndefined();
    expect(safeFile(d, 'A/sub', 'x.pdf')).toBeUndefined();
    expect(safeFile(d, 'A', '..\\B\\x.pdf')).toBeUndefined();
    expect(safeFile(d, 'A\\..\\B', 'x.pdf')).toBeUndefined();
  });
});
