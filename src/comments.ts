import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { contentProblem } from './contentguard.js';
import { replaceFile } from './files.js';
import { currentQuestion } from './flow.js';
import { FlowStore, loadFlow } from './flowstore.js';
import type { Ctx, ToolDef } from './tools.js';
import { botMayAnswer, loadTestMode } from './testmode.js';

// Comment replies as the Page. Claude writes each reply (a real answer, not a template); the code enforces the
// safety limits so the Page never looks like a spam bot to Meta:
//   - only people's top-level comments on our own recent posts, never our own, one reply per comment;
//   - wait FB_COMMENT_MIN_DELAY_SEC after the comment before replying (no instant bot replies);
//   - at most FB_COMMENT_MAX_PER_HOUR replies an hour and FB_COMMENT_MAX_PER_DAY in 24 hours;
//   - never the same reply text twice in 24 hours (Meta flags copy-paste replies);
//   - every text passes the Community Standards guard (graph.post);
//   - a private Messenger reply (comment to DM) when FB_COMMENT_PRIVATE_REPLY is on. Meta hides who commented, so it can
//     land in a chat that is mid-application; Meta tells us the recipient after sending, and then the bot picks the
//     application up again with the question they were on.
// Off until the owner turns on FB_COMMENTS_LIVE.

export interface CommentState {
  started_at: string;
  handled: Record<string, { at: string; action: 'reply' | 'skip'; dm?: boolean }>;
  sent: { at: string; hash: string }[];
}

const FILE = 'comments.json';
const hashText = (t: string) => createHash('sha256').update(t.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 16);

export async function loadCommentState(dir: string, now = new Date()): Promise<CommentState> {
  try {
    const s = JSON.parse(await fs.readFile(path.join(dir, FILE), 'utf8')) as CommentState;
    return { started_at: s.started_at, handled: s.handled ?? {}, sent: s.sent ?? [] };
  } catch {
    // First run: comments made before now are left alone. Saved right away so the start time stays fixed (otherwise
    // every check would start "now" and no comment would ever be answered).
    const s: CommentState = { started_at: now.toISOString(), handled: {}, sent: [] };
    await saveCommentState(dir, s, now);
    return s;
  }
}

export async function saveCommentState(dir: string, s: CommentState, now = new Date()): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  // Keep a week of history; that is longer than any comment we still answer.
  const weekAgo = now.getTime() - 7 * 86_400_000;
  s.sent = s.sent.filter((x) => new Date(x.at).getTime() > weekAgo);
  const tmp = path.join(dir, `${FILE}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8');
  await replaceFile(tmp, path.join(dir, FILE));
}

export function repliesInLast(s: CommentState, ms: number, now = new Date()): number {
  return Object.values(s.handled).filter((h) => h.action === 'reply' && now.getTime() - new Date(h.at).getTime() < ms).length;
}
export const repliesInLastHour = (s: CommentState, now = new Date()) => repliesInLast(s, 3_600_000, now);

export interface PendingComment {
  comment_id: string;
  post_id: string;
  post_text: string;
  author: string;
  text: string;
  created_time: string;
  /** False until FB_COMMENT_MIN_DELAY_SEC has passed since the comment. */
  ready: boolean;
}

const FINISHED = ['done', 'declined', 'rejected', 'excluded'];

/** The comment DM went to someone mid-application: send the question they were on, so the chat carries on. */
export async function resumeApplication(ctx: Ctx, pageId: string, psid: string, now = new Date()): Promise<boolean> {
  const p = (await new FlowStore(ctx.cfg.flowDir).load(now)).people[psid];
  if (!p || FINISHED.includes(p.stage) || !botMayAnswer(await loadTestMode(ctx.cfg.flowDir), psid)) return false;
  const q = currentQuestion(loadFlow(ctx.cfg.flowFile), p);
  if (!q) return false;
  // Same buttons as before: Messenger only shows quick replies on the newest message, so the DM hid them.
  const text = `Tuloy natin ang application mo 🙂

${q.reply}`;
  const quick_replies = q.choices?.map((c) => ({ content_type: 'text', title: c, payload: c }));
  await ctx.graph.post(pageId, `${pageId}/messages`, {
    recipient: JSON.stringify({ id: psid }),
    message: JSON.stringify(quick_replies?.length ? { text, quick_replies } : { text }),
    messaging_type: 'RESPONSE',
  });
  return true;
}

/** People's new top-level comments on our posts from the last FB_COMMENT_POST_DAYS days. */
export async function findPendingComments(ctx: Ctx, pageId: string, now = new Date()) {
  const s = await loadCommentState(ctx.cfg.flowDir, now);
  const since = Math.max(new Date(s.started_at).getTime(), now.getTime() - ctx.cfg.FB_COMMENT_POST_DAYS * 86_400_000);
  const posts = await ctx.graph.get(pageId, `${pageId}/posts`, {
    fields: `id,message,created_time,comments.limit(50).filter(toplevel).order(reverse_chronological){id,from,message,created_time,is_hidden}`,
    limit: '25',
  });
  const tm = await loadTestMode(ctx.cfg.flowDir);
  const out: PendingComment[] = [];
  for (const p of posts.data ?? []) {
    if (new Date(p.created_time).getTime() < now.getTime() - ctx.cfg.FB_COMMENT_POST_DAYS * 86_400_000) continue;
    for (const c of p.comments?.data ?? []) {
      if (s.handled[c.id] || c.is_hidden || c.from?.id === pageId || !botMayAnswer(tm, c.from?.id, c.id)) continue;
      const at = new Date(c.created_time).getTime();
      if (at < since || !c.message) continue;
      out.push({
        comment_id: c.id,
        post_id: p.id,
        post_text: String(p.message ?? '').slice(0, 280),
        author: String(c.from?.name ?? '').split(/\s+/)[0] ?? '',
        text: String(c.message).slice(0, 1000),
        created_time: c.created_time,
        ready: now.getTime() - at >= ctx.cfg.FB_COMMENT_MIN_DELAY_SEC * 1000,
      });
    }
  }
  out.sort((a, b) => a.created_time.localeCompare(b.created_time));
  const left = Math.min(ctx.cfg.FB_COMMENT_MAX_PER_HOUR - repliesInLastHour(s, now), ctx.cfg.FB_COMMENT_MAX_PER_DAY - repliesInLast(s, 86_400_000, now));
  const private_message_ok = ctx.cfg.FB_COMMENT_PRIVATE_REPLY && ctx.cfg.FB_MESSENGER_LIVE;
  return { comments: out, replies_left_this_hour: Math.max(0, left), private_message_ok };
}

// Owner rule: replies must read like a person typed them, not like AI. These give a bot away.
const AI_TELLS: { re: RegExp; why: string }[] = [
  { re: /\b(great|good|excellent) question\b|\babsolutely!|\bcertainly!|\bwe'?re (thrilled|delighted)|\bfeel free\b|\bhope this helps\b|\bdon'?t hesitate\b|\bas an ai\b|\bi'?m an? (ai|bot)\b|\bkindly\b|\bwe appreciate your\b/i, why: 'sounds like a bot' },
  { re: /[—–]|\s-\s/, why: 'uses dashes (people rarely type them in comments)' },
  { re: /#\w|https?:\/\/|www\./i, why: 'has a hashtag or link' },
  { re: /^\s*[-*•]\s|\n\s*[-*•]\s/m, why: 'uses a list' },
];

/** Why a reply sounds like a bot, or undefined. */
export function soundsLikeBot(reply: string): string | undefined {
  const t = AI_TELLS.find((x) => x.re.test(reply));
  if (t) return t.why;
  if ((reply.match(/\p{Extended_Pictographic}/gu) ?? []).length > 1) return 'has more than one emoji';
  if (reply.split(/[.!?]+\s/).filter((x) => x.trim()).length > 3) return 'is too long (keep it to 1-2 short sentences)';
  return undefined;
}

/** Why this reply may not be sent, or undefined when it may. Shared by the tool and tests. */
export function replyRefusal(s: CommentState, maxPerHour: number, reply: string, now = new Date(), maxPerDay = Infinity): string | undefined {
  if (repliesInLastHour(s, now) >= maxPerHour) return `Hourly limit reached (${maxPerHour}). Try again later.`;
  if (repliesInLast(s, 86_400_000, now) >= maxPerDay) return `Daily limit reached (${maxPerDay} in 24 hours). Try again tomorrow.`;
  const h = hashText(reply);
  if (s.sent.some((x) => x.hash === h && now.getTime() - new Date(x.at).getTime() < 86_400_000))
    return 'Same reply text was already used today. Write a reply for this person.';
  const why = contentProblem(reply);
  if (why) return `Not sent: the text ${why}.`;
  const bot = soundsLikeBot(reply);
  if (bot) return `Not sent: the reply ${bot}. Rewrite it the way a person would type it.`;
  return undefined;
}

const id = z.string().regex(/^[0-9_]+$/, 'Must be a numeric Facebook id');

export const commentTools: ToolDef[] = [
  {
    name: 'fb_comment_pending',
    description:
      "People's new comments on the Page's recent posts that have no reply yet (oldest first), and how many replies are left this hour. " +
      'Reply only to comments with ready=true.',
    write: false,
    input: { page_id: id },
    handler: ({ page_id }, ctx) => findPendingComments(ctx, page_id),
  },
  {
    name: 'fb_comment_answer',
    description:
      'Handle one comment. action="reply": post a short public reply as the Page (your own words for this person; the same text twice is refused). ' +
      'Add private_message only when fb_comment_pending said private_message_ok=true. ' +
      'action="skip": no reply (spam, rude, off-topic, or nothing to add).',
    write: true,
    input: {
      page_id: id,
      comment_id: id,
      action: z.enum(['reply', 'skip']),
      reply: z.string().trim().min(2).max(600).optional(),
      private_message: z.string().trim().min(2).max(600).optional(),
    },
    handler: async ({ page_id, comment_id, action, reply, private_message }, ctx) => {
      if (!ctx.cfg.FB_COMMENTS_LIVE) throw new Error('Comment replies are off (FB_COMMENTS_LIVE). Owner turns them on.');
      const now = new Date();
      const { comments, private_message_ok } = await findPendingComments(ctx, page_id, now);
      const c = comments.find((x) => x.comment_id === comment_id);
      if (!c) throw new Error('This comment is not waiting for a reply (already handled, hidden, ours, or too old).');
      const s = await loadCommentState(ctx.cfg.flowDir, now);
      if (action === 'skip') {
        s.handled[comment_id] = { at: now.toISOString(), action: 'skip' };
        await saveCommentState(ctx.cfg.flowDir, s, now);
        return { ok: true, skipped: true };
      }
      if (!c.ready) throw new Error(`Too soon: wait until ${ctx.cfg.FB_COMMENT_MIN_DELAY_SEC}s after the comment.`);
      if (!reply) throw new Error('reply is required for action="reply".');
      if (private_message && !private_message_ok)
        throw new Error('Private messages from comments are off. Reply publicly and invite them to send the Page a message.');
      const refusal = replyRefusal(s, ctx.cfg.FB_COMMENT_MAX_PER_HOUR, reply, now, ctx.cfg.FB_COMMENT_MAX_PER_DAY) ?? (private_message ? contentProblem(private_message) && `Not sent: the private message ${contentProblem(private_message)}.` : undefined);
      if (refusal) throw new Error(refusal);
      await ctx.graph.post(page_id, `${comment_id}/comments`, { message: reply });
      s.handled[comment_id] = { at: now.toISOString(), action: 'reply' };
      s.sent.push({ at: now.toISOString(), hash: hashText(reply) });
      let dm = false;
      let resumed = false;
      if (private_message) {
        try {
          // Comment to Messenger ("private reply"): Meta allows one per comment, within 7 days.
          const r = await ctx.graph.post(page_id, `${page_id}/messages`, { recipient: JSON.stringify({ comment_id }), message: JSON.stringify({ text: private_message }) });
          dm = true;
          if (r?.recipient_id) resumed = await resumeApplication(ctx, page_id, String(r.recipient_id), now);
        } catch {
          // The public reply already went out; the DM is optional.
        }
      }
      s.handled[comment_id].dm = dm;
      await saveCommentState(ctx.cfg.flowDir, s, now);
      return { ok: true, replied: true, private_message_sent: dm, application_resumed: resumed };
    },
  },
];
