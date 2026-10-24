import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commentTools, findPendingComments, loadCommentState, replyRefusal, soundsLikeBot } from '../src/comments.js';
import { commentPrompt } from '../src/commentwatch.js';
import { IdempotencyStore } from '../src/idempotency.js';
import { PAGE_ID, testConfig } from './helpers.js';

const now = new Date();
const ago = (sec: number) => new Date(now.getTime() - sec * 1000).toISOString();

function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-'));
  const posts: any[] = [];
  const graph = {
    gets: [] as string[],
    posts,
    get: async (_p: string, p: string) => {
      graph.gets.push(p);
      return {
        data: [
          {
            id: `${PAGE_ID}_1`,
            message: 'Miles or cashback?',
            created_time: ago(3600),
            comments: {
              data: [
                { id: '11', from: { id: '900', name: 'Ana Cruz' }, message: 'Miles for me!', created_time: ago(300) },
                { id: '12', from: { id: '901', name: 'Ben' }, message: 'How do I apply?', created_time: ago(20) },
                { id: '13', from: { id: PAGE_ID, name: 'CARD MAX' }, message: 'Ours', created_time: ago(200) },
                { id: '14', from: { id: '902', name: 'Spam' }, message: 'hidden one', created_time: ago(200), is_hidden: true },
              ],
            },
          },
        ],
      };
    },
    post: async (_p: string, p: string, params: any) => {
      posts.push({ p, params });
      return { id: 'r' };
    },
  };
  const cfg = testConfig({ FB_COMMENTS_LIVE: 'true', FB_FLOW_DIR: dir, FB_WRITE_ENABLED: 'true', ...env });
  const ctx = { cfg, graph: graph as any, idem: new IdempotencyStore(60_000) };
  return { ctx, graph, dir };
}

const answer = commentTools.find((t) => t.name === 'fb_comment_answer')!.handler;

async function primeState(dir: string) {
  const { saveCommentState } = await import('../src/comments.js');
  await saveCommentState(dir, { started_at: ago(7200), handled: {}, sent: [] });
}

describe('comment replies', () => {
  it('lists only people’s visible comments, marks the too-new ones not ready', async () => {
    const { ctx, dir } = setup();
    await primeState(dir);
    const r = await findPendingComments(ctx, PAGE_ID, now);
    expect(r.comments.map((c) => [c.comment_id, c.ready])).toEqual([
      ['11', true],
      ['12', false],
    ]);
    expect(r.comments[0].author).toBe('Ana');
  });

  it('replies once, refuses too-soon, repeats, bot-sounding text, and when the switch is off', async () => {
    const { ctx, graph, dir } = setup();
    await primeState(dir);
    await expect(answer({ page_id: PAGE_ID, comment_id: '12', action: 'reply', reply: 'Sent you a message!' }, ctx)).rejects.toThrow(/Too soon/);
    await expect(answer({ page_id: PAGE_ID, comment_id: '11', action: 'reply', reply: 'Great question! Miles are nice.' }, ctx)).rejects.toThrow(/bot/);
    expect(await answer({ page_id: PAGE_ID, comment_id: '11', action: 'reply', reply: 'Same here, miles add up fast if you travel.' }, ctx)).toMatchObject({ replied: true });
    expect(graph.posts[0]).toMatchObject({ p: '11/comments', params: { message: 'Same here, miles add up fast if you travel.' } });
    await expect(answer({ page_id: PAGE_ID, comment_id: '11', action: 'reply', reply: 'Another one' }, ctx)).rejects.toThrow(/not waiting/);
    expect((await loadCommentState(dir)).handled['11'].action).toBe('reply');
    const off = setup({ FB_COMMENTS_LIVE: '' });
    await expect(answer({ page_id: PAGE_ID, comment_id: '11', action: 'skip' }, off.ctx)).rejects.toThrow(/off/);
  });

  it('a private message goes to Messenger only for a reply, once', async () => {
    const { ctx, graph, dir } = setup({ FB_COMMENT_MIN_DELAY_SEC: '30' });
    await primeState(dir);
    await answer({ page_id: PAGE_ID, comment_id: '11', action: 'reply', reply: 'Sent you a message!', private_message: 'Hi Ana, we can help you apply for free if you already have a credit card. Just reply here.' }, ctx);
    expect(graph.posts.map((x) => x.p)).toEqual(['11/comments', `${PAGE_ID}/messages`]);
    expect(JSON.parse(graph.posts[1].params.recipient)).toEqual({ comment_id: '11' });
  });

  it('limits: same text twice a day, hourly cap, Meta rules', () => {
    const s = { started_at: ago(7200), handled: {} as any, sent: [] as any[] };
    expect(replyRefusal(s, 15, 'Nice one, thanks!', now)).toBeUndefined();
    s.sent.push({ at: ago(60), hash: require('node:crypto').createHash('sha256').update('nice one, thanks!').digest('hex').slice(0, 16) });
    expect(replyRefusal(s, 15, 'Nice  one, thanks!', now)).toMatch(/already used/);
    for (let i = 0; i < 3; i++) s.handled[`x${i}`] = { at: ago(100), action: 'reply' };
    expect(replyRefusal(s, 3, 'Different text here', now)).toMatch(/Hourly limit/);
    expect(replyRefusal(s, 15, 'Guaranteed approval for you', now)).toMatch(/approval/);
    expect(replyRefusal(s, 15, 'Tag a friend who needs this', now)).toMatch(/engagement bait/);
  });

  it('human-sounding check', () => {
    for (const t of ['Absolutely! We can help.', 'Feel free to message us.', 'Yes — we help.', 'See https://x.com', 'Nice 😀🎉', 'Hope this helps!', '- one\n- two'])
      expect(soundsLikeBot(t)).toBeDefined();
    for (const t of ['Haha same, cashback is my thing too 😄', "Sent you a message! Let's get you sorted there.", 'Yep, call the hotline and ask. It worked for a lot of people.'])
      expect(soundsLikeBot(t)).toBeUndefined();
  });

  it('the prompt asks for English, human replies, and no approval promises', () => {
    const p = commentPrompt(PAGE_ID);
    expect(p).toMatch(/English/);
    expect(p).toMatch(/Sound human/);
    expect(p).toMatch(/never promise approval/);
  });
});
