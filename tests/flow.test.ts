import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sendNudges } from '../src/flowtools.js';
import { advance, cleanSuggestions, flowSchema, idVerdict, newPerson, parseYesNo, quickReply, scriptCanAnswer, validAnswer, type IdSeen, type Person } from '../src/flow.js';
import { FlowStore, loadFlow } from '../src/flowstore.js';
import { callTool, tools } from '../src/tools.js';
import { param, testCtx, type Call } from './helpers.js';

const EXAMPLE = path.resolve('flow.example.json');
const flow = loadFlow(EXAMPLE);
const NOW = new Date('2026-10-25T12:00:00Z');
const run = (p: Person, text: string, image_url?: string, now = NOW) => advance(flow, p, { text, image_url }, now, 180);

/** Walk a person through the script; returns the final result. */
function walk(...answers: (string | { image: string })[]) {
  let r = run(newPerson(NOW), 'hi');
  for (const a of answers) r = typeof a === 'string' ? run(r.person, a) : run(r.person, '', a.image);
  return r;
}

describe('parseYesNo (old bot bug: substring "no" rejected real yeses)', () => {
  it.each([
    ['Oo, meron ako noon', 'yes'],
    ['meron po', 'yes'],
    ['YES', 'yes'],
    ['Opo', 'yes'],
    ['wala pa', 'no'],
    ['hindi pa po', 'no'],
    ['No', 'no'],
  ])('%s -> %s', (t, want) => expect(parseYesNo(t)).toBe(want));

  it.each(['Oo, wala pang 1 year', 'Yes, no annual fee yung akin', 'magkano po?', ''])(
    'unclear "%s" is asked again, never read as no',
    (t) => expect(parseYesNo(t)).toBeUndefined(),
  );
});

describe('advance (script)', () => {
  it('first message sends greeting + consent', () => {
    const r = run(newPerson(NOW), 'hello');
    expect(r.reply).toContain(flow.greeting);
    expect(r.reply).toContain(flow.consent.prompt);
    expect(r.person.stage).toBe('consent');
  });

  it('declined consent stores nothing and stops', () => {
    const r = walk('hindi');
    expect(r.person.stage).toBe('declined');
    expect(r.person.consent_at).toBeUndefined();
    expect(r.reply).toBe(flow.consent.decline_reply);
  });

  it('unclear answer repeats the question and does not move on', () => {
    const r = walk('yes', 'Oo, wala pang 1 year');
    expect(r.person.stage).toBe('carded');
    expect(r.reply).toContain(flow.carded.prompt);
  });

  it('no credit card -> reject with 180-day cooldown, silent during cooldown, restarts after', () => {
    const r = walk('yes', 'wala pa');
    expect(r.person.stage).toBe('rejected');
    expect(r.reply).toBe(flow.carded.reject_reply);
    expect(new Date(r.person.cooldown_until!).getTime() - NOW.getTime()).toBe(180 * 86_400_000);

    const during = run(r.person, 'hello ulit', undefined, new Date(NOW.getTime() + 179 * 86_400_000));
    expect(during.reply).toBeUndefined();
    expect(during.person.stage).toBe('rejected');

    const after = run(r.person, 'hello ulit', undefined, new Date(NOW.getTime() + 181 * 86_400_000));
    expect(after.person.stage).toBe('consent');
    expect(after.reply).toContain(flow.consent.prompt);
  });

  it('cards from all 4 excluded banks -> excluded', () => {
    const r = walk('yes', 'oo', 'BPI, Metro Bank, RCBC at East West');
    expect(r.person.stage).toBe('excluded');
    expect(r.reply).toBe(flow.banks.excluded_reply);
  });

  it('3 of the 4 banks -> continues', () => {
    const r = walk('yes', 'oo', 'BPI, Metrobank, RCBC');
    expect(r.person.stage).toBe('steps');
    expect(r.reply).toBe(flow.steps[0]!.prompt);
  });

  it('no bank named -> asks again', () => {
    const r = walk('yes', 'oo', 'marami po');
    expect(r.person.stage).toBe('banks');
    expect(r.reply).toBe(flow.banks.unknown_reply);
  });

  it('single applicant skips spouse; ID must be a photo; a photo waits for Claude review', () => {
    let r = walk('yes', 'oo', 'BDO', 'Juan Cruz', 'single', '09171234567');
    expect(r.person.stage).toBe('id_photo');
    r = run(r.person, 'eto po ID number ko 123');
    expect(r.reply).toBe(flow.id_photo.need_image_reply);
    r = run(r.person, '', 'https://scontent.fbcdn.net/x.jpg');
    expect(r.received_id_image).toBe('https://scontent.fbcdn.net/x.jpg');
    expect(r.reply).toBeUndefined();
    expect(r.completed).toBeUndefined();
    expect(r.person.stage).toBe('id_photo');
    expect(r.person.answers).toEqual({ full_name: 'Juan Cruz', civil_status: 'single', mobile: '09171234567' });
  });

  it('married applicant gets the spouse question', () => {
    const r = walk('yes', 'oo', 'BDO', 'Juan Cruz', 'married', '09171234567');
    expect(r.person.stage).toBe('steps');
    expect(r.reply).toBe(flow.steps[3]!.prompt);
  });

  it('only the civil status answer decides married (a name with "kasal" does not)', () => {
    const r = walk('yes', 'oo', 'BDO', 'Kasal Bakeshop owner', 'single', '09171234567');
    expect(r.person.married).toBe(false);
    expect(r.person.stage).toBe('id_photo');
  });

  it('one question per message; a bad mobile number is asked again', () => {
    const r = walk('yes', 'oo', 'BDO', 'Juan Cruz', 'single', 'wala akong number');
    expect(r.person.stage).toBe('steps');
    expect(r.person.answers.mobile).toBeUndefined();
    expect(r.reply).toBe(`${flow.steps[2]!.invalid_reply}

${flow.steps[2]!.prompt}`);
  });

  it('after done, the script stays quiet (Claude answers)', () => {
    const r = walk('yes', 'oo', 'BDO', 'Juan', 'single', '09171234567');
    expect(run({ ...r.person, stage: 'done' }, 'salamat').reply).toBeUndefined();
  });
});

// ---- tools against a fake Graph API ----------------------------------------
const PSID = '999';
const tool = (name: string) => tools.find((t) => t.name === name)!;

function setup(messages: Record<string, { text?: string; from?: string; image?: string; time?: string }>, opts: { failSend?: 'error' | 'uncertain' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'flow-'));
  writeFileSync(path.join(dir, 'test-mode.json'), JSON.stringify({ on: false, ids: [] })); // live behavior
  const env = { FB_WRITE_ENABLED: 'true', FB_FLOW_FILE: EXAMPLE, FB_FLOW_DIR: dir };
  const sent: string[] = [];
  const msg = (mid: string) => {
    const m = messages[mid]!;
    return {
      id: mid,
      message: m.text ?? '',
      from: { id: m.from ?? PSID },
      created_time: m.time ?? new Date().toISOString(),
      attachments: m.image ? { data: [{ mime_type: 'image/jpeg', image_data: { url: m.image } }] } : undefined,
    };
  };
  const { ctx, calls } = testCtx(env, (c: Call) => {
    const p = c.url.pathname;
    if (p.endsWith('/111/messages')) {
      if (opts.failSend === 'error') return { status: 500, json: { error: { code: 2, message: 'down' } } };
      sent.push(JSON.parse(param(c, 'message')!).text);
      return { json: { message_id: 'm_out' } };
    }
    if (p.endsWith('/111/conversations')) {
      return {
        json: {
          data: [
            {
              updated_time: new Date().toISOString(),
              participants: { data: [{ id: PSID, name: 'Tester' }, { id: '111', name: 'Page' }] },
              messages: { data: Object.keys(messages).reverse().map(msg) },
            },
          ],
        },
      };
    }
    const mid = p.split('/').pop()!;
    if (messages[mid]) return { json: msg(mid) };
    return { json: {} };
  });
  if (opts.failSend === 'uncertain') {
    const orig = ctx.graph.post.bind(ctx.graph);
    ctx.graph.post = (async (...a: Parameters<typeof orig>) => {
      if (String(a[1]).endsWith('/messages')) throw Object.assign(new Error('maybe'), { uncertain: true });
      return orig(...a);
    }) as typeof ctx.graph.post;
  }
  return { ctx, calls, sent, dir };
}

const answer = (ctx: any, ids: string[], kind: 'answer' | 'question' = 'answer') =>
  callTool(tool('fb_flow_answer'), { page_id: '111', psid: PSID, message_ids: ids, kind }, ctx) as Promise<any>;

describe('flow tools', () => {
  it('pending lists only unhandled messages from the person, oldest first', async () => {
    const { ctx } = setup({ m_1: { text: 'hi' }, m_2: { text: 'page reply', from: '111' }, m_3: { text: 'hello?' } });
    const out: any = await callTool(tool('fb_flow_pending'), { page_id: '111' }, ctx);
    expect(out).toHaveLength(1);
    expect(out[0].messages.map((m: any) => m.id)).toEqual(['m_1', 'm_3']);
    expect(out[0].stage).toBe('new');
    expect(out[0].can_reply).toBe(true);
  });

  it('test mode: only listed testers are answered; nobody when the list is empty', async () => {
    const { ctx, dir, sent } = setup({ m_1: { text: 'hi' } });
    writeFileSync(path.join(dir, 'test-mode.json'), JSON.stringify({ on: true, ids: [] }));
    expect(await callTool(tool('fb_flow_pending'), { page_id: '111' }, ctx)).toEqual([]);
    await expect(answer(ctx, ['m_1'])).rejects.toThrow();
    expect(sent).toHaveLength(0);
    writeFileSync(path.join(dir, 'test-mode.json'), JSON.stringify({ on: true, ids: [PSID + '00000'] }));
    expect(await callTool(tool('fb_flow_pending'), { page_id: '111' }, ctx)).toEqual([]);
  });

  it('ignores messages older than the first run (never replies to old chats)', async () => {
    const { ctx } = setup({ m_old: { text: 'hi', time: '2020-01-01T00:00:00Z' } });
    expect(await callTool(tool('fb_flow_pending'), { page_id: '111' }, ctx)).toEqual([]);
  });

  it('answer sends the script reply once; the same message twice does nothing', async () => {
    const { ctx, sent } = setup({ m_1: { text: 'hi' } });
    const r = await answer(ctx, ['m_1']);
    expect(r.stage).toBe('consent');
    expect(sent).toHaveLength(1);
    expect((await answer(ctx, ['m_1'])).note).toBe('Already handled.');
    expect(sent).toHaveLength(1);
    expect(await callTool(tool('fb_flow_pending'), { page_id: '111' }, ctx)).toEqual([]);
  });

  it('refuses a message that is not from this person', async () => {
    const { ctx, sent } = setup({ m_x: { text: 'hi', from: '555' } });
    await expect(answer(ctx, ['m_x'])).rejects.toThrow(/not from this person/);
    expect(sent).toHaveLength(0);
  });

  it('kind=question marks handled without moving the script', async () => {
    const { ctx, sent } = setup({ m_1: { text: 'hi' }, m_2: { text: 'magkano annual fee?' } });
    await answer(ctx, ['m_1']);
    const r = await answer(ctx, ['m_2'], 'question');
    expect(r.stage).toBe('consent');
    expect(r.current_question).toContain('Do you agree');
    expect(sent).toHaveLength(2); // the question goes again, so its buttons come back
  });

  it('a failed send is saved and resent exactly once, without running the script twice', async () => {
    const s1 = setup({ m_1: { text: 'hi' } }, { failSend: 'error' });
    await expect(answer(s1.ctx, ['m_1'])).rejects.toThrow();
    const st = await new FlowStore(s1.dir).load(new Date());
    expect(st.people[PSID]!.outbox?.text).toContain('Do you agree');
    expect(st.people[PSID]!.stage).toBe('consent');

    // Network back: same dir, working send.
    const s2 = setup({ m_1: { text: 'hi' } });
    (s2.ctx.cfg as any).flowDir = s1.dir;
    const r = await answer(s2.ctx, ['m_1']);
    expect(r.resent_earlier_reply).toContain('Do you agree');
    expect(s2.sent).toHaveLength(1);
    expect((await new FlowStore(s1.dir).load(new Date())).people[PSID]!.stage).toBe('consent');
  });

  it('a maybe-sent reply is not sent again', async () => {
    const { ctx, sent, dir } = setup({ m_1: { text: 'hi' } }, { failSend: 'uncertain' });
    const r = await answer(ctx, ['m_1']);
    expect(r.note).toMatch(/may not have gone through/);
    const st = await new FlowStore(dir).load(new Date());
    expect(st.people[PSID]!.outbox).toBeUndefined();
    expect(st.handled).toContain('m_1');
    expect(sent).toHaveLength(0);
  });

  it('outside the reply window: nothing is sent', async () => {
    const { ctx, sent, dir } = setup({ m_1: { text: 'hi' } });
    await new FlowStore(dir).save({ version: 1, started_at: '2020-01-01T00:00:00Z', people: {}, handled: [] });
    const old = setup({ m_1: { text: 'hi', time: new Date(Date.now() - 30 * 3_600_000).toISOString() } });
    (old.ctx.cfg as any).flowDir = dir;
    const r = await answer(old.ctx, ['m_1']);
    expect(r.note).toMatch(/24-hour/);
    expect(sent.length + old.sent.length).toBe(0);
  });

  it('ID from a non-Meta host is not downloaded: the person is asked to resend', async () => {
    const msgs = {
      m_1: { text: 'hi' },
      m_2: { text: 'yes' },
      m_3: { text: 'oo' },
      m_4: { text: 'BDO' },
      m_5: { text: 'Juan' },
      m_6: { text: 'single' },
      m_7: { text: '09171234567' },
      m_8: { image: 'https://evil.example.com/id.jpg' },
    };
    const { ctx, dir } = setup(msgs);
    let r: any;
    for (const mid of Object.keys(msgs)) r = await answer(ctx, [mid]);
    expect(r.reply).toBe(flow.id_photo.unclear_reply);
    expect(r.stage).toBe('id_photo');
    expect(existsSync(path.join(dir, 'valid_ids'))).toBe(false);
  });

  it('one reminder to someone who stopped mid-application, only inside the 24-hour window', async () => {
    const msgs = { m_1: { text: 'hi' }, m_2: { text: 'yes' }, m_3: { text: 'oo' } };
    const { ctx, sent } = setup(msgs);
    for (const mid of Object.keys(msgs)) await answer(ctx, [mid]);
    const asked = sent.length;
    const at = (h: number) => new Date(Date.now() + h * 3_600_000);
    expect(await sendNudges(ctx, '111', at(1))).toBe(0); // too soon (default: after 3 hours)
    expect(await sendNudges(ctx, '111', at(4))).toBe(1);
    expect(sent.at(-1)).toMatch(/^Hi! Tuloy pa ba natin/);
    expect(sent.at(-1)).toContain(sent[asked - 1]); // the question they stopped at
    expect(await sendNudges(ctx, '111', at(5))).toBe(0); // only once per stop
    expect(sent).toHaveLength(asked + 1);

    const late = setup(msgs);
    for (const mid of Object.keys(msgs)) await answer(late.ctx, [mid]);
    expect(await sendNudges(late.ctx, '111', at(21))).toBe(0); // too close to the end of Meta's 24-hour window

    const done = setup({ m_1: { text: 'hi' }, m_2: { text: 'no' } }); // declined: never reminded
    for (const mid of ['m_1', 'm_2']) await answer(done.ctx, [mid]);
    expect(await sendNudges(done.ctx, '111', at(4))).toBe(0);
  });

  it('a saved ID photo (already handled) can still be replied to after Claude reads it', async () => {
    const msgs = {
      m_1: { text: 'hi' },
      m_2: { text: 'yes' },
      m_3: { text: 'oo' },
      m_4: { text: 'BDO' },
      m_5: { text: 'Juan' },
      m_6: { text: 'single' },
      m_7: { text: '09171234567' },
      m_8: { image: 'https://scontent.fbcdn.net/cat.jpg' },
    };
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(50), { headers: { 'content-type': 'image/jpeg' } }));
    try {
      const { ctx } = setup(msgs);
      for (const mid of Object.keys(msgs)) await answer(ctx, [mid]);
      const p = ((await callTool(tool('fb_flow_pending'), { page_id: '111' }, ctx)) as any[]).find((x) => x.psid === PSID);
      expect(p).toMatchObject({ needs_id_review: true, can_reply: true, messages: [] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ID photo -> Claude sees it -> review decides with the owner rules -> lead saved', async () => {
    const msgs = {
      m_1: { text: 'hi' },
      m_2: { text: 'yes' },
      m_3: { text: 'oo' },
      m_4: { text: 'BDO' },
      m_5: { text: 'Juan' },
      m_6: { text: 'single' },
      m_7: { text: '09171234567' },
      m_8: { image: 'https://scontent.fbcdn.net/prc-front.jpg' },
      m_9: { image: 'https://scontent.fbcdn.net/prc-back.jpg' },
    };
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(50), { headers: { 'content-type': 'image/jpeg' } }));
    try {
      const { ctx, dir, sent } = setup(msgs);
      let r: any;
      for (const mid of Object.keys(msgs).slice(0, 8)) r = await answer(ctx, [mid]);
      expect(r.needs_id_review).toBe(true);
      expect(r.id_photos).toBe(1);
      // The photo is already in our folder; the pending list keeps asking Claude to read it.
      expect(readdirSync(path.join(dir, 'valid_ids'))).toHaveLength(1);
      const pend = async () => ((await callTool(tool('fb_flow_pending'), { page_id: '111' }, ctx)) as any[]).find((p) => p.psid === PSID);
      expect((await pend())?.needs_id_review).toBe(true);

      const imgs: any = await callTool(tool('fb_flow_id_images'), { psid: PSID }, ctx);
      expect(imgs.__content.filter((c: any) => c.type === 'image')).toHaveLength(1);

      const review = (photos: any[]) => callTool(tool('fb_flow_id_review'), { page_id: '111', psid: PSID, photos }, ctx) as Promise<any>;
      const prcFront = { type: 'prc', side: 'front', clear: true, has_signature: true };
      await expect(review([prcFront, prcFront])).rejects.toThrow(/one entry per ID photo/);

      r = await review([prcFront]);
      expect(r.id_ok).toBe(false);
      expect((await pend())?.needs_id_review).toBe(false);
      expect(r.reply).toBe(flow.id_photo.need_back_reply);

      r = await answer(ctx, ['m_9']);
      expect(r.id_photos).toBe(2);
      r = await review([prcFront, { type: 'prc', side: 'back', clear: true, has_signature: false }]);
      expect(r.reply).toBe(flow.id_photo.need_second_reply);
      expect(r.stage).toBe('id_photo');

      // Not at the ID step any more after completing; a second review is refused.
      const state = await new FlowStore(dir).load(new Date());
      state.people[PSID]!.id_files = [...state.people[PSID]!.id_files!, 'valid_ids/x.jpg'];
      await new FlowStore(dir).save(state);
      r = await review([prcFront, { type: 'prc', side: 'back', clear: true, has_signature: false }, { type: 'tin', side: 'front', clear: true, has_signature: true }]);
      expect(r.id_ok).toBe(true);
      expect(r.stage).toBe('done');
      expect(r.reply).toBe(flow.done_reply);
      const lead = JSON.parse(readFileSync(path.join(dir, r.lead_saved), 'utf8'));
      expect(lead.id_photos).toHaveLength(3);
      expect(lead.id_review[2].type).toBe('tin');
      expect(lead.answers.mobile).toBe('09171234567');
      expect(lead.consent_at).toBeTruthy();
      await expect(review([prcFront])).rejects.toThrow(/not at the ID photo step/);
      expect(sent.at(-1)).toBe(flow.done_reply);
      // Until the PDFs are made, the pending list keeps asking Claude to finalize (it may stop before doing it).
      expect((await pend())?.needs_finalize).toBe(r.lead_saved);
      // IDs that do not look right: Claude holds it for the owner, and the retries stop.
      await expect(callTool(tool('fb_lead_hold'), { lead_file: 'lead-1-x.json', reason: 'ids_do_not_match' }, ctx)).rejects.toThrow(/No application/);
      await callTool(tool('fb_lead_hold'), { lead_file: r.lead_saved, reason: 'ids_do_not_match' }, ctx);
      expect(await pend()).toBeUndefined();
      expect(await callTool(tool('fb_flow_status'), {}, ctx)).toMatchObject({ held_for_id_check: 1 });
      await callTool(tool('fb_lead_finalize'), { lead_file: r.lead_saved, details: {} }, ctx);
      expect(await pend()).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('status shows counts only, no personal details', async () => {
    const { ctx } = setup({ m_1: { text: 'hi' } });
    await answer(ctx, ['m_1']);
    const s: any = await callTool(tool('fb_flow_status'), {}, ctx);
    expect(s.stages).toEqual({ consent: 1 });
    expect(JSON.stringify(s)).not.toContain(PSID);
  });

  it('reset needs confirm and forgets the person', async () => {
    const { ctx, dir } = setup({ m_1: { text: 'hi' } });
    await answer(ctx, ['m_1']);
    await expect(callTool(tool('fb_flow_reset'), { psid: PSID }, ctx)).rejects.toThrow();
    expect(await callTool(tool('fb_flow_reset'), { psid: PSID, confirm: true }, ctx)).toEqual({ reset: true });
    expect((await new FlowStore(dir).load(new Date())).people[PSID]).toBeUndefined();
    expect(readdirSync(dir).some((f) => f.endsWith('.lock'))).toBe(false);
  });
});

describe('saveIdImage', () => {
  const ok = (type: string, size = 10) =>
    (async () => new Response(new Uint8Array(size), { headers: { 'content-type': type } })) as unknown as typeof fetch;

  it('saves a Meta CDN image', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'img-'));
    const f = await new FlowStore(dir).saveIdImage('9', 'https://scontent.fmnl4-1.fna.fbcdn.net/a.jpg', NOW, 1000, 1000, ok('image/jpeg'));
    expect(f).toMatch(/^valid_ids\/9-.*\.jpg$/);
    expect(existsSync(path.join(dir, f!))).toBe(true);
  });

  it.each([
    ['non-Meta host', 'https://fbcdn.net.evil.com/a.jpg', ok('image/jpeg')],
    ['not an image', 'https://x.fbcdn.net/a', ok('text/html')],
    ['too big', 'https://x.fbcdn.net/a.jpg', ok('image/jpeg', 2000)],
  ])('refuses %s', async (_n, url, fn) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'img-'));
    expect(await new FlowStore(dir).saveIdImage('9', url, NOW, 1000, 1000, fn)).toBeUndefined();
  });
});

describe('watcher prompt', () => {
  it('names the page, limits Claude to the flow, and forbids asking for card secrets', async () => {
    const { operatorPrompt } = await import('../src/watch.js');
    const p = operatorPrompt('123');
    expect(p).toContain('page_id 123');
    expect(p).toMatch(/Never ask for a card number, CVV, OTP, PIN/);
    expect(p).toMatch(/Never promise approval/);
    expect(p).toMatch(/Never suggest or guess personal details/);
    expect(p).toMatch(/business owner.*Self-employed.*WebSearch the business name/s);
    expect(p).toMatch(/unit\/floor\/building, street, barangay/);
  });
});

describe('validAnswer', () => {
  it.each([
    ['mobile', '0917 123 4567', true],
    ['mobile', '+63 917-123-4567', true],
    ['mobile', '12345', false],
    ['email', 'juan@gmail.com', true],
    ['email', 'juan at gmail', false],
    ['tin', '123-456-789', true],
    ['tin', '123-456-789-000', true],
    ['tin', '1234', false],
    ['sss_gsis', '34-1234567-8', true],
    ['sss_gsis', '123', false],
    ['date', '01/15/2020', true],
    ['date', '13/40/20', false],
    ['number', '5 years', true],
    ['number', 'matagal na', false],
  ] as const)('%s "%s" -> %s', (kind, text, ok) => expect(validAnswer(kind, text)).toBe(ok));

  it('a flow step with validate but no invalid_reply is refused', () => {
    expect(() => flowSchema.parse({ ...flow, steps: [{ key: 'a', prompt: 'x', validate: 'email' }] })).toThrow();
  });
});

describe('pending-application question (EastWest returns: duplicate / with pending app)', () => {
  const f = flowSchema.parse({
    ...flow,
    steps: [
      { key: 'pending_application', prompt: 'Pending app?', validate: 'yes_no', invalid_reply: 'Oo o Hindi lang po.', flag_if_yes: 'pending_application' },
      ...flow.steps,
    ],
  });
  const go = (...answers: string[]) => {
    let r = advance(f, newPerson(NOW), { text: 'hi' }, NOW, 180);
    for (const a of answers) r = advance(f, r.person, { text: a }, NOW, 180);
    return r;
  };

  it('yes: continues and flags the lead', () => {
    const r = go('oo', 'meron', 'BDO', 'oo meron sa BPI');
    expect(r.person.stage).toBe('steps');
    expect(r.person.flags).toEqual(['pending_application']);
    expect(r.reply).toBe(flow.steps[0]!.prompt);
  });

  it('no: continues without a flag', () => {
    const r = go('oo', 'meron', 'BDO', 'wala');
    expect(r.person.flags ?? []).toEqual([]);
    expect(r.person.stage).toBe('steps');
  });

  it('unclear: asked again, nothing saved', () => {
    const r = go('oo', 'meron', 'BDO', 'siguro?');
    expect(r.person.answers.pending_application).toBeUndefined();
    expect(r.reply).toBe('Oo o Hindi lang po.\n\nPending app?');
  });

  it('flag_if_yes without yes_no is refused', () => {
    expect(() => flowSchema.parse({ ...flow, steps: [{ key: 'a', prompt: 'x', flag_if_yes: 'a' }] })).toThrow();
  });
});

describe('buttons, optional groups and suggestions', () => {
  const f = flowSchema.parse({
    ...flow,
    consent: { ...flow.consent, choices: ['Oo', 'Hindi'] },
    steps: [
      { key: 'employer_name', prompt: 'Employer?' },
      { key: 'office_address', prompt: 'Office address?', suggest: true },
      { key: 'civil_status', prompt: 'Civil status?', sets_married: true, choices: ['Single', 'Married'] },
      { key: 'reference_name', prompt: 'Reference name?', optional_group: 'reference' },
      { key: 'reference_mobile', prompt: 'Reference mobile?', optional_group: 'reference', validate: 'mobile', invalid_reply: 'Bad number.' },
      { key: 'spouse_name', prompt: 'Spouse?', only_if_married: true },
    ],
  });
  const start = () => {
    let r = advance(f, newPerson(NOW), { text: 'hi' }, NOW, 180);
    for (const a of ['oo', 'meron']) r = advance(f, r.person, { text: a }, NOW, 180);
    return advance(f, r.person, { text: 'BDO' }, NOW, 180);
  };
  const SUGG = ['Alabang Town Center, Ayala Alabang, Muntinlupa', 'Festival Mall, Filinvest, Alabang, Muntinlupa'];

  it('consent question carries its buttons', () => {
    const r = advance(f, newPerson(NOW), { text: 'hi' }, NOW, 180);
    expect(r.choices).toEqual(['Oo', 'Hindi']);
  });

  it('suggestions for the next question are numbered with number buttons + Iba', () => {
    const r = advance(f, start().person, { text: 'Jollibee Alabang' }, NOW, 180, SUGG);
    expect(r.reply).toBe(`Office address?\n\n1) ${SUGG[0]}\n2) ${SUGG[1]}`);
    expect(r.choices).toEqual(['1', '2', 'Iba']);
  });

  it('short suggestions (≤20 chars) are the buttons themselves, no numbered list', () => {
    const r = advance(f, start().person, { text: 'Jollibee Alabang' }, NOW, 180, ['Restaurant', 'Food service']);
    expect(r.reply).toBe('Office address?');
    expect(r.choices).toEqual(['Restaurant', 'Food service', 'Iba']);
    expect(advance(f, r.person, { text: 'Food service' }, NOW, 180).person.answers.office_address).toBe('Food service');
  });

  it('tapping a number saves that suggestion; typing saves the typed text', () => {
    const asked = advance(f, start().person, { text: 'Jollibee Alabang' }, NOW, 180, SUGG);
    expect(advance(f, asked.person, { text: '2' }, NOW, 180).person.answers.office_address).toBe(SUGG[1]);
    expect(advance(f, asked.person, { text: 'SM Southmall' }, NOW, 180).person.answers.office_address).toBe('SM Southmall');
    expect(advance(f, asked.person, { text: '7' }, NOW, 180).person.answers.office_address).toBe('7');
  });

  it('"Iba" asks them to type and keeps the question', () => {
    const asked = advance(f, start().person, { text: 'Jollibee Alabang' }, NOW, 180, SUGG);
    const r = advance(f, asked.person, { text: 'Iba' }, NOW, 180);
    expect(r.reply).toBe(f.other_reply);
    expect(r.person.answers.office_address).toBeUndefined();
    expect(r.person.suggestions).toBeUndefined();
  });

  it('suggestions are ignored for a question without suggest', () => {
    const r = advance(f, start().person, { text: 'x' }, NOW, 180);
    const r2 = advance(f, r.person, { text: 'Some address' }, NOW, 180, ['should not show']);
    expect(r2.reply).toBe('Civil status?');
    expect(r2.choices).toEqual(['Single', 'Married']);
  });

  it('optional group: first question shows Skip; "skip" skips the whole group', () => {
    let r = start();
    for (const a of ['Jollibee', 'ATC', 'single']) r = advance(f, r.person, { text: a }, NOW, 180);
    expect(r.reply).toBe('Reference name?');
    expect(r.choices).toEqual(['Skip']);
    r = advance(f, r.person, { text: 'Skip' }, NOW, 180);
    expect(r.person.stage).toBe('id_photo');
    expect(r.person.answers.reference_name).toBeUndefined();
  });

  it('optional TIN: Skip moves on; a wrong TIN is asked again; a good one is saved', () => {
    const g = flowSchema.parse({
      ...f,
      steps: [
        { key: 'tin', prompt: 'TIN?', optional_group: 'tin', validate: 'tin', invalid_reply: 'Bad TIN.' },
        { key: 'employer_name', prompt: 'Employer?' },
      ],
    });
    const s = () => {
      let r = advance(g, newPerson(NOW), { text: 'hi' }, NOW, 180);
      for (const a of ['oo', 'meron', 'BDO']) r = advance(g, r.person, { text: a }, NOW, 180);
      return r;
    };
    expect(s().choices).toEqual(['Skip']);
    expect(advance(g, s().person, { text: 'Skip' }, NOW, 180).reply).toBe('Employer?');
    const bad = advance(g, s().person, { text: '1234' }, NOW, 180);
    expect(bad.reply).toContain('Bad TIN.');
    expect(bad.person.answers.tin).toBeUndefined();
    const ok = advance(g, s().person, { text: '123-456-789' }, NOW, 180);
    expect(ok.person.answers.tin).toBe('123-456-789');
    expect(ok.reply).toBe('Employer?');
  });

  it('a real reference name is not mistaken for skip', () => {
    let r = start();
    for (const a of ['Jollibee', 'ATC', 'married', 'Pedro Wala Cruz']) r = advance(f, r.person, { text: a }, NOW, 180);
    expect(r.person.answers.reference_name).toBe('Pedro Wala Cruz');
    expect(r.reply).toBe('Reference mobile?');
    r = advance(f, r.person, { text: '09171234567' }, NOW, 180);
    expect(r.reply).toBe('Spouse?');
  });

  it('cleanSuggestions trims, dedupes, drops blanks and long ones, keeps 5', () => {
    expect(cleanSuggestions([' a ', 'a', '', 'x'.repeat(201), 'b', 'c', 'd', 'e', 'f'])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('button titles over 20 characters are refused in the flow file', () => {
    expect(() => flowSchema.parse({ ...flow, consent: { ...flow.consent, choices: ['x'.repeat(21)] } })).toThrow();
  });
});

describe('flow tools: buttons are sent as Messenger quick replies', () => {
  it('sends quick_replies with the consent question', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flowqr-'));
    writeFileSync(path.join(dir, 'test-mode.json'), JSON.stringify({ on: false, ids: [] }));
    const flowFile = path.join(dir, 'flow.json');
    writeFileSync(flowFile, JSON.stringify({ ...flow, consent: { ...flow.consent, choices: ['Oo', 'Hindi'] } }));
    const bodies: any[] = [];
    const { ctx } = testCtx({ FB_WRITE_ENABLED: 'true', FB_FLOW_FILE: flowFile, FB_FLOW_DIR: dir }, (c: Call) => {
      if (c.url.pathname.endsWith('/111/messages')) {
        bodies.push(JSON.parse(param(c, 'message')!));
        return { json: { message_id: 'm_out' } };
      }
      return { json: { id: 'm_1', message: 'hi', from: { id: PSID }, created_time: new Date().toISOString() } };
    });
    const r: any = await callTool(tool('fb_flow_answer'), { page_id: '111', psid: PSID, message_ids: ['m_1'], kind: 'answer' }, ctx);
    expect(r.buttons).toEqual(['Oo', 'Hindi']);
    expect(bodies[0].quick_replies).toEqual([
      { content_type: 'text', title: 'Oo', payload: 'Oo' },
      { content_type: 'text', title: 'Hindi', payload: 'Hindi' },
    ]);
  });
});

describe('idVerdict (owner ID rules)', () => {
  const id = (type: IdSeen['type'], o: Partial<IdSeen> = {}): IdSeen => ({ type, side: 'front', clear: true, has_signature: true, ...o });
  const t = flow.id_photo;
  it.each([
    ['drivers license alone', [id('drivers_license')], true],
    ['passport alone', [id('passport')], true],
    ['UMID alone', [id('umid')], true],
    ['postal alone', [id('postal')], true],
    ["voter's alone", [id('voters')], true],
    ['old SSS with birthday alone', [id('sss_old')], true],
    ['PRC both sides + TIN', [id('prc', { side: 'both' }), id('tin')], true],
    ['PRC front + back photos + PhilHealth', [id('prc'), id('prc', { side: 'back' }), id('philhealth')], true],
    ['blurry first try, then a clear passport', [id('passport', { clear: false }), id('passport')], true],
    ['new SSS + PhilHealth', [id('sss_new'), id('philhealth')], true],
    ['National ID both sides + TIN with signature', [id('national_id', { side: 'both' }), id('tin')], true],
  ] as const)('%s -> ok', (_n, ids, ok) => expect(idVerdict(flow, [...ids]).ok).toBe(ok));

  it.each([
    ['PRC front only', [id('prc')], t.need_back_reply],
    ['PRC both sides alone', [id('prc', { side: 'both' })], t.need_second_reply],
    ['new SSS alone', [id('sss_new')], t.need_second_reply],
    ['National ID both sides alone', [id('national_id', { side: 'both' })], t.need_signature_reply],
    ['National ID + ID without signature', [id('national_id', { side: 'both' }), id('philhealth', { has_signature: false })], t.need_signature_reply],
    ['PRC + unknown other ID', [id('prc', { side: 'both' }), id('other')], t.need_second_reply],
    ['secondary only', [id('tin'), id('philhealth')], t.need_primary_reply],
    ['blurry passport', [id('passport', { clear: false })], t.unclear_reply],
    ['a non-ID picture, then a clear PhilHealth (only the newest photo decides blurry)', [id('other', { clear: false }), id('philhealth')], t.need_primary_reply],
    ['clear PhilHealth, then a blurry photo', [id('philhealth'), id('other', { clear: false })], t.unclear_reply],
    ['nothing', [], t.need_image_reply],
  ] as const)('%s -> asks again', (_n, ids, reply) => expect(idVerdict(flow, [...ids])).toEqual({ ok: false, reply }));
});

describe('fast lane (script answers without Claude)', () => {
  const f = flowSchema.parse({
    ...flow,
    consent: { ...flow.consent, choices: ['Oo', 'Hindi'] },
    steps: [
      { key: 'civil_status', prompt: 'Civil status?', sets_married: true, choices: ['Single', 'Married'] },
      { key: 'mobile', prompt: 'Mobile?', validate: 'mobile', invalid_reply: 'Bad.' },
      { key: 'place_of_birth', prompt: 'Saan ka pinanganak?' },
      { key: 'tin', prompt: 'TIN?', optional_group: 'tin', validate: 'tin', invalid_reply: 'Bad TIN.' },
    ],
  });
  const at = (stage: Person['stage'], step = 0): Person => ({ ...newPerson(NOW), stage, step });
  const can = (p: Person, text: string, image_url?: string) => scriptCanAnswer(f, p, { text, image_url });

  it('greetings, clear yes/no and bank names are answered right away', () => {
    expect(can(at('new'), 'hi')).toBe(true);
    expect(can(at('new'), 'Good evening po')).toBe(true);
    expect(can(at('consent'), 'Oo')).toBe(true);
    expect(can(at('carded'), 'meron')).toBe(true);
    expect(can(at('banks'), 'BDO at BPI')).toBe(true);
  });

  it('questions, unclear replies and images go to Claude', () => {
    expect(can(at('new'), 'magkano po fee')).toBe(false);
    expect(can(at('new'), 'hi, legit ba kayo?')).toBe(false);
    expect(can(at('new'), 'hi I want to ask about the process for my mom')).toBe(false);
    expect(can(at('consent'), 'ewan ko')).toBe(false);
    expect(can(at('consent'), 'oo pero paano?')).toBe(false);
    expect(can(at('banks'), 'yung sa mall')).toBe(false);
    expect(can(at('consent'), '', 'https://scontent.xx.fbcdn.net/x.jpg')).toBe(false);
    expect(can(at('id_photo'), 'ok')).toBe(false);
    expect(can(at('done'), 'thanks')).toBe(false);
  });

  it('an ID photo at the ID step is downloaded at once (Claude reads it after)', () => {
    expect(can(at('id_photo'), '', 'https://scontent.xx.fbcdn.net/x.jpg')).toBe(true);
  });

  it('steps: tapped buttons, valid numbers and plain short answers; bad numbers and questions go to Claude', () => {
    expect(can(at('steps', 0), 'Married')).toBe(true);
    expect(can(at('steps', 1), '0917 123 4567')).toBe(true);
    expect(can(at('steps', 1), 'wala akong cp')).toBe(false);
    expect(can(at('steps', 2), 'Marilao, Bulacan')).toBe(true);
    expect(can(at('steps', 2), 'bakit kailangan')).toBe(false);
    expect(can(at('steps', 3), 'Skip')).toBe(true);
    expect(can(at('steps', 3), '123-456-789')).toBe(true);
    expect(can(at('steps', 3), '12')).toBe(false);
  });
});

describe('flow tools: an off-script question', () => {
  it('sends the current question again with its buttons', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flowq-'));
    writeFileSync(path.join(dir, 'test-mode.json'), JSON.stringify({ on: false, ids: [] }));
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, started_at: new Date(0).toISOString(), handled: [], people: { [PSID]: { stage: 'carded', step: 0, answers: {}, banks: [], married: false, updated_at: new Date().toISOString() } } }));
    const flowFile = path.join(dir, 'flow.json');
    writeFileSync(flowFile, JSON.stringify({ ...flow, carded: { ...flow.carded, choices: ['Oo', 'Wala pa'] } }));
    const bodies: any[] = [];
    const { ctx } = testCtx({ FB_WRITE_ENABLED: 'true', FB_FLOW_FILE: flowFile, FB_FLOW_DIR: dir }, (c: Call) => {
      if (c.method === 'POST') {
        bodies.push(JSON.parse(new URLSearchParams(String(c.body)).get('message')!));
        return { json: { message_id: 'm_out' } };
      }
      return { json: { id: 'm_1', message: 'magkano po?', from: { id: PSID }, created_time: new Date().toISOString() } };
    });
    const r: any = await callTool(tool('fb_flow_answer'), { page_id: '111', psid: PSID, message_ids: ['m_1'], kind: 'question' }, ctx);
    expect(r.buttons).toEqual(['Oo', 'Wala pa']);
    expect(bodies[0].text).toBe(flow.carded.prompt);
    expect(bodies[0].quick_replies.map((q: any) => q.title)).toEqual(['Oo', 'Wala pa']);
    expect(JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')).handled).toContain('m_1');
  });
});

describe('detail of a flag', () => {
  const steps = [
    { key: 'pending', prompt: 'Pending?', validate: 'yes_no' as const, invalid_reply: 'Yes or no', flag_if_yes: 'pending_application' },
    { key: 'pending_bank', prompt: 'Which bank?', detail_of_flag: 'pending_application' },
    { key: 'birth', prompt: 'Where born?' },
  ];
  const f = { ...flow, steps };
  const start = { ...newPerson(NOW), stage: 'steps' as const };

  it('asks which bank only after a yes, and adds it to the flag', () => {
    const yes = advance(f, start, { text: 'Oo' }, NOW, 180);
    expect(yes.reply).toBe('Which bank?');
    const bank = advance(f, yes.person, { text: 'Metrobank' }, NOW, 180);
    expect(bank.reply).toBe('Where born?');
    expect(bank.person.flags).toEqual(['pending_application: Metrobank']);
  });

  it('skips the bank question after a no', () => {
    const no = advance(f, start, { text: 'Wala' }, NOW, 180);
    expect(no.reply).toBe('Where born?');
    expect(no.person.flags).toBeUndefined();
  });
});

describe('bank buttons', () => {
  const withButtons = { ...flow, banks: { ...flow.banks, choices: ['BPI', 'Metrobank', 'RCBC', 'EastWest', 'BDO'], more_prompt: 'More?', done_choice: 'Tapos na' } };
  const start = { ...newPerson(NOW), stage: 'banks' as const };

  it('collects banks one tap at a time and shows only those not picked', () => {
    const a = advance(withButtons, start, { text: 'BDO' }, NOW, 180);
    expect(a.person.stage).toBe('banks');
    expect(a.person.banks).toEqual(['BDO']);
    expect(a.reply).toBe('More?');
    expect(a.choices).toEqual(['BPI', 'Metrobank', 'RCBC', 'EastWest', 'Tapos na']);
    expect(advance(withButtons, a.person, { text: 'Tapos na' }, NOW, 180).person.stage).toBe('steps');
  });

  it('still excludes a person with all four banks, only after they finish', () => {
    let p: typeof start = start;
    for (const text of ['BPI', 'Metrobank', 'RCBC', 'EastWest']) p = advance(withButtons, p, { text }, NOW, 180).person as typeof start;
    expect(p.stage).toBe('banks');
    expect(advance(withButtons, p, { text: 'Tapos na' }, NOW, 180).person.stage).toBe('excluded');
  });

  it('done does nothing before a bank is picked', () => {
    const a = advance(withButtons, start, { text: 'Tapos na' }, NOW, 180);
    expect(a.person.stage).toBe('banks');
    expect(a.reply).toBe(flow.banks.unknown_reply);
  });

  it('the script answers taps by itself', () => {
    expect(scriptCanAnswer(withButtons, start, { text: 'BDO' })).toBe(true);
    expect(scriptCanAnswer(withButtons, { ...start, banks: ['BDO'] }, { text: 'Tapos na' })).toBe(true);
    expect(scriptCanAnswer(withButtons, start, { text: 'Tapos na' })).toBe(false);
  });
});

describe('bank buttons: none of these', () => {
  const f = { ...flow, banks: { ...flow.banks, choices: ['BPI', 'China Bank'], more_prompt: 'More?', done_choice: 'Tapos na', none_choice: 'Wala dito' } };
  const start = { ...newPerson(NOW), stage: 'banks' as const };

  it('moves on with no bank listed, and shows it only before a pick', () => {
    const none = advance(f, start, { text: 'Wala dito' }, NOW, 180);
    expect(none.person.stage).toBe('steps');
    expect(none.person.banks).toEqual([]);
    expect(scriptCanAnswer(f, start, { text: 'Wala dito' })).toBe(true);
    expect(advance(f, start, { text: 'BPI' }, NOW, 180).choices).toEqual(['China Bank', 'Tapos na']);
  });

  it('a typed bank outside the buttons still counts', () => {
    expect(advance(f, start, { text: 'BDO' }, NOW, 180).person.banks).toEqual(['BDO']);
  });
});

describe('autofill buttons', () => {
  const steps = [
    { key: 'birth', prompt: 'Where born?' },
    { key: 'email', prompt: 'Email?', validate: 'email' as const, invalid_reply: 'Bad email', autofill: 'user_email' as const },
  ];
  const f = { ...flow, steps };
  const start = { ...newPerson(NOW), stage: 'steps' as const };

  it('asks with the profile email button and saves the value they send', () => {
    const a = advance(f, start, { text: 'Manila' }, NOW, 180);
    expect(a.choices!.map(quickReply)).toEqual([{ content_type: 'user_email' }]);
    expect(advance(f, a.person, { text: 'a@b.co' }, NOW, 180).person.answers.email).toBe('a@b.co');
  });

  it('plain buttons keep their title', () => {
    expect(quickReply('Oo')).toEqual({ content_type: 'text', title: 'Oo', payload: 'Oo' });
    expect(quickReply('autofill:user_phone_number')).toEqual({ content_type: 'user_phone_number' });
  });
});

describe('answers Claude must check', () => {
  const steps = [{ key: 'home_address', prompt: 'Address?', check: 'Street, barangay, city' }];
  const f = { ...flow, steps };
  const p = { ...newPerson(NOW), stage: 'steps' as const };

  it('the script never accepts them alone', () => {
    expect(scriptCanAnswer(f, p, { text: 'Quezon City' })).toBe(false);
    expect(scriptCanAnswer({ ...flow, steps: [{ key: 'home_address', prompt: 'Address?' }] }, p, { text: 'Quezon City' })).toBe(true);
  });

  it('the operator is told to ask for the missing part and never fill it in', async () => {
    const { operatorPrompt } = await import('../src/watch.js');
    expect(operatorPrompt('1')).toMatch(/never compare an ID with the Facebook name/);
    expect(operatorPrompt('1')).not.toMatch(/names do not match the applicant/);
    expect(operatorPrompt('1')).toMatch(/answer_check/);
    expect(operatorPrompt('1')).toMatch(/Never fill in a part yourself/);
    expect(operatorPrompt('1')).toMatch(/send the whole answer again/);
  });
});

describe('civil status check', () => {
  const f = { ...flow, steps: [{ key: 'civil_status', prompt: 'Civil status?', sets_married: true, validate: 'civil_status' as const, invalid_reply: 'Pick one.', choices: ['Single', 'Married'] }, { key: 'next_one', prompt: 'Next?' }] };
  const p = { ...newPerson(NOW), stage: 'steps' as const };
  const say = (text: string) => advance(f, p, { text }, NOW, 30);

  it('refuses anything that is not a civil status, at once, and asks again with the buttons', () => {
    for (const bad of ['camarines norte', 'not married', 'asdf']) {
      expect(scriptCanAnswer(f, p, { text: bad })).toBe(true);
      const r = say(bad);
      expect(r.reply).toBe('Pick one.\n\nCivil status?');
      expect(r.choices).toEqual(['Single', 'Married']);
      expect(r.person.step).toBe(0);
      expect(r.person.answers.civil_status).toBeUndefined();
      expect(r.person.married).toBe(false);
    }
  });

  it('saves the form word for buttons and typed answers', () => {
    expect(say('Single').person.answers.civil_status).toBe('Single');
    expect(say('dalaga po').person.answers.civil_status).toBe('Single');
    const married = say('may asawa').person;
    expect(married.answers.civil_status).toBe('Married');
    expect(married.married).toBe(true);
    expect(say('Kasal po').person.married).toBe(true);
  });

  it('a question still goes to Claude', () => {
    expect(scriptCanAnswer(f, p, { text: 'ano po yan?' })).toBe(false);
  });
});

describe('auto_accept', () => {
  const f = { ...flow, steps: [{ key: 'place_of_birth', prompt: 'Where?', check: 'City', auto_accept: 'birthplace' as const }] };
  const p = { ...newPerson(NOW), stage: 'steps' as const };

  it('the script answers a clear answer and leaves the rest to Claude', () => {
    expect(scriptCanAnswer(f, p, { text: 'Taguig' })).toBe(true);
    expect(scriptCanAnswer(f, p, { text: 'Bulacan' })).toBe(false);
  });

  describe('province_only_reply', () => {
    const steps = [{ ...f.steps[0]!, province_only_reply: 'Saan sa {province}? Halimbawa: {example}' }, { key: 'next_one', prompt: 'Next?' }];
    const g = { ...flow, steps };
    const say = (who: Person, text: string) => advance(g, who, { text }, NOW, 30);

    it('asks at once where in the province, without Claude', () => {
      expect(scriptCanAnswer(g, p, { text: 'sa Bulacan po' })).toBe(true);
      const r = say(p, 'sa Bulacan po');
      expect(r.reply).toBe('Saan sa Bulacan? Halimbawa: Malolos');
      expect(r.person.step).toBe(0);
      expect(r.person.answers.place_of_birth).toBeUndefined();
    });

    it('joins the next answer to the province and moves on', () => {
      const asked = say(p, 'Bulacan').person;
      expect(scriptCanAnswer(g, asked, { text: 'Malolos' })).toBe(true);
      const r = say(asked, 'Malolos').person;
      expect(r.answers.place_of_birth).toBe('Malolos, Bulacan');
      expect(r.step).toBe(1);
      expect(r.place_province).toBeUndefined();
    });

    it('keeps a full answer as typed, and a misspelled town still reaches the spelling check', () => {
      const asked = say(p, 'Bulacan').person;
      expect(say(asked, 'Malolos, Bulacan').person.answers.place_of_birth).toBe('Malolos, Bulacan');
      expect(say(asked, 'Maloloss').person.answers.place_of_birth).toBe('Maloloss, Bulacan');
    });

    it('a question while asked still goes to Claude', () => {
      expect(scriptCanAnswer(g, say(p, 'Bulacan').person, { text: 'bakit po?' })).toBe(false);
    });

    it('covers Metro Manila too, and a city there stays the city alone', () => {
      const r = say(p, 'NCR');
      expect(r.reply).toMatch(/^Saan sa Metro Manila\? Halimbawa: \S/);
      expect(say(r.person, 'Taguig').person.answers.place_of_birth).toBe('Taguig');
    });

    it('a place that is not only a province is untouched', () => {
      expect(say(p, 'Taguig').person.answers.place_of_birth).toBe('Taguig');
      expect(say(p, 'Quezon City').person.answers.place_of_birth).toBe('Quezon City');
    });
  });
});

describe('ID photo received', () => {
  it('tells the client right away, saves the photo and waits for the review', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flowid-'));
    writeFileSync(path.join(dir, 'test-mode.json'), JSON.stringify({ on: false, ids: [] }));
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, started_at: new Date(0).toISOString(), handled: [], people: { [PSID]: { stage: 'id_photo', step: 0, answers: {}, banks: [], married: false, updated_at: new Date().toISOString() } } }));
    const flowFile = path.join(dir, 'flow.json');
    writeFileSync(flowFile, JSON.stringify({ ...flow, id_photo: { ...flow.id_photo, received_reply: 'Received!' } }));
    const bodies: any[] = [];
    const { ctx } = testCtx({ FB_WRITE_ENABLED: 'true', FB_FLOW_FILE: flowFile, FB_FLOW_DIR: dir }, (c: Call) => {
      if (c.url.pathname.endsWith('/111/messages')) {
        bodies.push(JSON.parse(param(c, 'message')!));
        return { json: { message_id: 'm_out' } };
      }
      return { json: { id: 'm_1', message: '', from: { id: PSID }, created_time: new Date().toISOString(), attachments: { data: [{ mime_type: 'image/jpeg', image_data: { url: 'https://scontent.fbcdn.net/id.jpg' } }] } } };
    });
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(50), { headers: { 'content-type': 'image/jpeg' } }));
    try {
      const r: any = await callTool(tool('fb_flow_answer'), { page_id: '111', psid: PSID, message_ids: ['m_1'], kind: 'answer' }, ctx);
      expect(r).toMatchObject({ reply: 'Received!', needs_id_review: true, id_photos: 1 });
      expect(bodies.map((b) => b.text)).toEqual(['Received!']);
      const st = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
      expect(st.people[PSID].id_files).toHaveLength(1);
      expect(st.people[PSID].stage).toBe('id_photo');
      expect(st.handled).toContain('m_1');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
