import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { advance, cleanSuggestions, flowSchema, newPerson, parseYesNo, validAnswer, type Person } from '../src/flow.js';
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

  it('single applicant skips spouse; ID must be a photo; completes', () => {
    let r = walk('yes', 'oo', 'BDO', 'Juan Cruz', 'single', '09171234567');
    expect(r.person.stage).toBe('id_photo');
    r = run(r.person, 'eto po ID number ko 123');
    expect(r.reply).toBe(flow.id_photo.need_image_reply);
    r = run(r.person, '', 'https://scontent.fbcdn.net/x.jpg');
    expect(r.completed).toBe(true);
    expect(r.person.stage).toBe('done');
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
    const r = walk('yes', 'oo', 'BDO', 'Juan', 'single', '09171234567', { image: 'https://x.fbcdn.net/a.jpg' });
    expect(run(r.person, 'salamat').reply).toBeUndefined();
  });
});

// ---- tools against a fake Graph API ----------------------------------------
const PSID = '999';
const tool = (name: string) => tools.find((t) => t.name === name)!;

function setup(messages: Record<string, { text?: string; from?: string; image?: string; time?: string }>, opts: { failSend?: 'error' | 'uncertain' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'flow-'));
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
    expect(sent).toHaveLength(1);
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

  it('full application saves a lead file; ID from a non-Meta host is not downloaded', async () => {
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
    expect(r.stage).toBe('done');
    expect(r.lead_saved).toMatch(/^lead-999-/);
    const lead = JSON.parse(readFileSync(path.join(dir, r.lead_saved), 'utf8'));
    expect(lead.banks).toEqual(['BDO']);
    expect(lead.answers.mobile).toBe('09171234567');
    expect(lead.consent_at).toBeTruthy();
    expect(lead.id_image_file).toBeUndefined();
    expect(existsSync(path.join(dir, 'valid_ids'))).toBe(false);
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
