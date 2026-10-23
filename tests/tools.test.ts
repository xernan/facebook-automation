import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callTool, tools } from '../src/tools.js';
import { param, testCtx } from './helpers.js';

const tool = (name: string) => {
  const t = tools.find((d) => d.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const WRITE_ON = { FB_WRITE_ENABLED: 'true' };
const inHour = () => new Date(Date.now() + 3_600_000).toISOString();

describe('tool registry', () => {
  it('has unique names and marks every mutating tool as write', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) {
      if (/_(create|update|delete|reply|hide|send)_/.test(`${t.name}_`)) expect(t.write, t.name).toBe(true);
    }
  });

  it('every delete tool requires confirm=true', async () => {
    const { ctx } = testCtx(WRITE_ON);
    const ids: Record<string, string> = { page_id: '111', post_id: '111_1', comment_id: '1' };
    const deletes = tools.filter((d) => d.name.includes('delete'));
    expect(deletes.length).toBeGreaterThan(0);
    for (const t of deletes) {
      const args = Object.fromEntries(Object.keys(t.input).filter((k) => k in ids).map((k) => [k, ids[k]]));
      await expect(callTool(t, args, ctx), t.name).rejects.toThrow(/confirm/);
      await expect(callTool(t, { ...args, confirm: true }, ctx), t.name).resolves.toBeDefined();
    }
  });
});

describe('write switch', () => {
  it('blocks writes while FB_WRITE_ENABLED is off', async () => {
    const { ctx, calls } = testCtx();
    await expect(callTool(tool('fb_create_post'), { page_id: '111', message: 'hi' }, ctx)).rejects.toThrow(/turned off/);
    expect(calls).toHaveLength(0);
  });

  it('lets reads through while writes are off', async () => {
    const { ctx } = testCtx({}, () => ({ json: { data: [{ id: '111_1' }] } }));
    const res: any = await callTool(tool('fb_list_posts'), { page_id: '111' }, ctx);
    expect(res.data).toHaveLength(1);
  });
});

describe('posts', () => {
  it('schedules a post with published=false', async () => {
    const { ctx, calls } = testCtx(WRITE_ON);
    await callTool(tool('fb_create_post'), { page_id: '111', message: 'hi', scheduled_time: inHour() }, ctx);
    const c = calls.at(-1)!;
    expect(c.url.pathname).toBe('/v26.0/111/feed');
    expect(param(c, 'published')).toBe('false');
    expect(Number(param(c, 'scheduled_publish_time'))).toBeGreaterThan(Date.now() / 1000);
  });

  it('does not post twice for the same idempotency key', async () => {
    const { ctx, calls } = testCtx(WRITE_ON);
    const args = { page_id: '111', message: 'hi', idempotency_key: 'launch-post-1' };
    await callTool(tool('fb_create_post'), args, ctx);
    await callTool(tool('fb_create_post'), args, ctx);
    expect(calls.filter((c) => c.url.pathname.endsWith('/feed'))).toHaveLength(1);
  });

  it('rejects empty posts and unknown fields', async () => {
    const { ctx } = testCtx(WRITE_ON);
    await expect(callTool(tool('fb_create_post'), { page_id: '111' }, ctx)).rejects.toThrow(/message, a link/);
    await expect(callTool(tool('fb_create_post'), { page_id: '111', message: 'x', access_token: 'x' }, ctx)).rejects.toThrow();
  });

  it('refuses to edit a post of another page', async () => {
    const { ctx } = testCtx(WRITE_ON);
    await expect(callTool(tool('fb_update_post'), { page_id: '111', post_id: '222_5', message: 'x' }, ctx)).rejects.toThrow(
      /does not belong/,
    );
  });
});

describe('photo upload', () => {
  const setup = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fbkit-'));
    mkdirSync(path.join(root, 'media'));
    writeFileSync(path.join(root, 'media', 'promo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(path.join(root, 'secret.png'), 'nope');
    return testCtx(WRITE_ON, undefined, root);
  };

  it('uploads a file from the media folder as multipart', async () => {
    const { ctx, calls } = setup();
    await callTool(tool('fb_create_photo_post'), { page_id: '111', image_file: 'promo.png', caption: 'Sale' }, ctx);
    const c = calls.at(-1)!;
    expect(c.body).toBeInstanceOf(FormData);
    expect(param(c, 'caption')).toBe('Sale');
  });

  it('blocks files outside the media folder', async () => {
    const { ctx, calls } = setup();
    await expect(
      callTool(tool('fb_create_photo_post'), { page_id: '111', image_file: '../secret.png' }, ctx),
    ).rejects.toThrow(/inside the media folder/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('blocks non-image files', async () => {
    const { ctx } = setup();
    await expect(callTool(tool('fb_create_photo_post'), { page_id: '111', image_file: '.env' }, ctx)).rejects.toThrow(
      /Unsupported/,
    );
  });
});

describe('messenger', () => {
  it('sends a private reply to a commenter', async () => {
    const { ctx, calls } = testCtx(WRITE_ON);
    await callTool(tool('fb_send_message'), { page_id: '111', comment_id: '5_6', text: 'Hi! Here is the price list.' }, ctx);
    const c = calls.at(-1)!;
    expect(JSON.parse(param(c, 'recipient')!)).toEqual({ comment_id: '5_6' });
    expect(param(c, 'messaging_type')).toBe('RESPONSE');
  });

  it('needs exactly one recipient', async () => {
    const { ctx } = testCtx(WRITE_ON);
    await expect(callTool(tool('fb_send_message'), { page_id: '111', text: 'x' }, ctx)).rejects.toThrow(/exactly one/);
  });
});

describe('leads', () => {
  it('pages through all leads and exports a CSV', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fbkit-'));
    let n = 0;
    const { ctx } = testCtx({}, () => {
      n++;
      return n === 1
        ? { json: { data: [{ id: 'L1', field_data: [{ name: 'email', values: ['a@b.c'] }] }], paging: { next: 'x', cursors: { after: 'c1' } } } }
        : { json: { data: [{ id: 'L2', field_data: [{ name: 'email', values: ['d@e.f'] }] }] } };
    }, root);
    const res: any = await callTool(tool('fb_get_leads'), { page_id: '111', form_id: '77', export_csv: true }, ctx);
    expect(res.count).toBe(2);
    expect(readFileSync(res.csv_file, 'utf8')).toContain('d@e.f');
    expect(path.dirname(res.csv_file)).toBe(path.join(root, 'exports'));
  });
});

describe('fb_graph_get', () => {
  it('rejects full URLs, query strings, traversal and auth params', async () => {
    const { ctx } = testCtx();
    const t = tool('fb_graph_get');
    for (const p of ['https://evil.com/x', '111?access_token=x', '../me', '111/../me']) {
      await expect(callTool(t, { page_id: '111', path: p }, ctx), p).rejects.toThrow();
    }
    await expect(callTool(t, { page_id: '111', path: '111', params: { access_token: 'x' } }, ctx)).rejects.toThrow();
  });

  it('passes plain reads through', async () => {
    const { ctx, calls } = testCtx();
    await callTool(tool('fb_graph_get'), { page_id: '111', path: '111/tagged', params: { fields: 'id' } }, ctx);
    expect(calls.at(-1)!.url.pathname).toBe('/v26.0/111/tagged');
  });
});
