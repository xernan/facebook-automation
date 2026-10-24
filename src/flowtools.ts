import { z } from 'zod';
import { advance, currentPrompt, newPerson, type Person } from './flow.js';
import { FlowStore, loadFlow, type FlowState } from './flowstore.js';
import type { Ctx, ToolDef } from './tools.js';

// Tools that run the Messenger application flow. Claude is the operator: fb_flow_pending shows who
// wrote, Claude decides whether each message answers the current question (the script replies) or is
// an off-script question (Claude replies itself with fb_send_message). Qualifier rules stay in flow.ts.

const id = z.string().regex(/^[0-9_]+$/, 'Must be a numeric Facebook id');
const pageId = id.describe('Page id from fb_list_pages');
const psid = id.describe('Person id (psid) from fb_flow_pending');
const confirm = z.literal(true).describe('Must be true. Confirms this cannot be undone.');

const MSG_FIELDS = 'id,message,from,created_time,attachments{mime_type,image_data,file_url}';

interface InMsg {
  id: string;
  text: string;
  image_url?: string;
  created_time: string;
}

function toInMsg(m: any): InMsg {
  const img = (m.attachments?.data ?? []).find(
    (a: any) => /^image\//.test(a.mime_type ?? '') && !a.image_data?.render_as_sticker,
  );
  return {
    id: m.id,
    text: typeof m.message === 'string' ? m.message : '',
    image_url: img?.image_data?.url ?? img?.file_url,
    created_time: m.created_time,
  };
}

const store = (ctx: Ctx) => new FlowStore(ctx.cfg.flowDir);
const withinWindow = (ctx: Ctx, iso: string, now: Date) =>
  now.getTime() - new Date(iso).getTime() < ctx.cfg.FB_FLOW_REPLY_WINDOW_HOURS * 3_600_000;

function markHandled(state: FlowState, ids: string[]) {
  for (const m of ids) if (!state.handled.includes(m)) state.handled.push(m);
}

/** Inbound messages not handled yet, per person, oldest first. Shared with the watcher. */
export async function findPending(ctx: Ctx, page_id: string, now = new Date()) {
  const s = store(ctx);
  const state = await s.load(now);
  // First run: save started_at so older chats stay ignored from now on.
  if (!(await s.exists())) await s.withLock(() => s.save(state));
  const start = new Date(state.started_at).getTime();
  const res = await ctx.graph.get(page_id, `${page_id}/conversations`, {
    platform: 'messenger',
    fields: `participants,updated_time,messages.limit(${ctx.cfg.FB_FLOW_MESSAGES_PER_CHAT}){${MSG_FIELDS}}`,
    limit: ctx.cfg.FB_LEADS_CHATS_PER_PAGE,
  });
  const flow = loadFlow(ctx.cfg.flowFile);
  const out = [];
  for (const conv of res.data ?? []) {
    if (new Date(conv.updated_time).getTime() < start) continue;
    const person = (conv.participants?.data ?? []).find((p: any) => p.id !== page_id);
    if (!person) continue;
    const msgs: InMsg[] = (conv.messages?.data ?? [])
      .filter((m: any) => m.from?.id === person.id)
      .map(toInMsg)
      .filter((m: InMsg) => new Date(m.created_time).getTime() >= start && !state.handled.includes(m.id))
      .reverse();
    const p = state.people[person.id];
    if (msgs.length === 0 && !p?.outbox) continue;
    const cur = p ?? newPerson(now);
    out.push({
      psid: person.id,
      name: person.name,
      stage: cur.stage,
      current_question: currentPrompt(flow, cur),
      outbox_pending: !!p?.outbox,
      can_reply: !!msgs.at(-1) && withinWindow(ctx, msgs.at(-1)!.created_time, now),
      messages: msgs.map((m) => ({ id: m.id, text: m.text, has_image: !!m.image_url, created_time: m.created_time })),
    });
  }
  return out;
}

async function send(ctx: Ctx, page_id: string, to: string, text: string) {
  await ctx.graph.post(page_id, `${page_id}/messages`, {
    recipient: JSON.stringify({ id: to }),
    message: JSON.stringify({ text }),
    messaging_type: 'RESPONSE',
  });
}

export const flowTools: ToolDef[] = [
  {
    name: 'fb_flow_pending',
    description:
      'Messenger application flow: people with new messages not handled yet, their stage, the question they are on, ' +
      'and the new messages (oldest first). For each person call fb_flow_answer. Personal data: never paste it anywhere public.',
    write: false,
    input: { page_id: pageId },
    handler: ({ page_id }, ctx) => findPending(ctx, page_id),
  },
  {
    name: 'fb_flow_answer',
    description:
      'Handle new messages from one person in the application flow. kind="answer": the messages answer the current question; ' +
      'the script decides the next reply (qualifier rules are enforced in code) and sends it. kind="question": the person asked ' +
      'something off-script; reply yourself with fb_send_message (then re-ask current_question), and this only marks the messages handled. ' +
      'If reply is null the script has nothing to say (finished, excluded or in cooldown): answer kindly yourself if needed. ' +
      'For a person at stage "new", always use kind="answer": it sends the greeting and consent question.',
    write: true,
    input: {
      page_id: pageId,
      psid,
      message_ids: z.array(z.string().regex(/^m_[A-Za-z0-9_-]+$/)).min(1).max(20),
      kind: z.enum(['answer', 'question']),
    },
    handler: async ({ page_id, psid: who, message_ids, kind }, ctx) => {
      const now = new Date();
      const s = store(ctx);
      const flow = loadFlow(ctx.cfg.flowFile);
      return s.withLock(async () => {
        const state = await s.load(now);
        const person = state.people[who] ?? newPerson(now);

        // A reply that failed to send earlier goes first, exactly once.
        if (person.outbox) {
          await send(ctx, page_id, who, person.outbox.text);
          markHandled(state, person.outbox.for_messages);
          const sent = person.outbox.text;
          delete person.outbox;
          state.people[who] = person;
          await s.save(state);
          return { resent_earlier_reply: sent, note: 'Call fb_flow_pending again for newer messages.' };
        }

        // Read each message from Meta: only this person's own, unhandled messages count.
        const msgs: InMsg[] = [];
        for (const mid of message_ids) {
          if (state.handled.includes(mid)) continue;
          const m = await ctx.graph.get(page_id, mid, { fields: MSG_FIELDS });
          if (m.from?.id !== who) throw new Error(`Message ${mid} is not from this person.`);
          msgs.push(toInMsg(m));
        }
        if (msgs.length === 0) return { note: 'Already handled.', stage: person.stage };
        msgs.sort((a, b) => a.created_time.localeCompare(b.created_time));
        const ids = msgs.map((m) => m.id);

        if (kind === 'question') {
          markHandled(state, ids);
          state.people[who] = person;
          await s.save(state);
          return { stage: person.stage, current_question: currentPrompt(flow, person) };
        }

        if (!withinWindow(ctx, msgs.at(-1)!.created_time, now)) {
          markHandled(state, ids);
          await s.save(state);
          return { reply: null, note: 'Outside the 24-hour reply window. Not sent.' };
        }

        const input = { text: msgs.map((m) => m.text).filter(Boolean).join('\n'), image_url: msgs.find((m) => m.image_url)?.image_url };
        const r = advance(flow, person, input, now, ctx.cfg.FB_FLOW_COOLDOWN_DAYS);
        const next: Person = r.person;

        let leadFile: string | undefined;
        if (r.completed) {
          const img = r.person.id_image_url
            ? await s.saveIdImage(who, r.person.id_image_url, now, ctx.cfg.FB_FLOW_MAX_IMAGE_MB * 1024 * 1024, ctx.cfg.FB_HTTP_TIMEOUT_MS)
            : undefined;
          delete next.id_image_url; // CDN links expire; the saved file is the record.
          leadFile = await s.saveLead(who, next, img, now);
        }

        if (!r.reply) {
          markHandled(state, ids);
          state.people[who] = next;
          await s.save(state);
          return { reply: null, stage: next.stage };
        }

        // Save the reply before sending: if sending fails, the next call resends it instead of re-running the script.
        next.outbox = { text: r.reply, for_messages: ids };
        state.people[who] = next;
        await s.save(state);
        try {
          await send(ctx, page_id, who, r.reply);
        } catch (err: any) {
          // Meta may have delivered it before the connection broke: never send twice.
          if (!err?.uncertain) throw err;
          delete next.outbox;
          markHandled(state, ids);
          await s.save(state);
          return { reply: r.reply, stage: next.stage, lead_saved: leadFile, note: 'Send may not have gone through. Check the chat with fb_get_messages.' };
        }
        delete next.outbox;
        markHandled(state, ids);
        await s.save(state);
        return { reply: r.reply, stage: next.stage, lead_saved: leadFile };
      });
    },
  },
  {
    name: 'fb_flow_status',
    description: 'Application flow overview: how many people are at each stage, and finished applications. No personal details.',
    write: false,
    input: {},
    handler: async (_args, ctx) => {
      const state = await store(ctx).load(new Date());
      const stages: Record<string, number> = {};
      for (const p of Object.values(state.people)) stages[p.stage] = (stages[p.stage] ?? 0) + 1;
      const outbox = Object.values(state.people).filter((p) => p.outbox).length;
      return { started_at: state.started_at, people: Object.keys(state.people).length, stages, replies_waiting_to_send: outbox };
    },
  },
  {
    name: 'fb_flow_reset',
    description: 'Forget one person in the application flow (e.g. a test chat) so their next message starts over. Finished lead files are kept.',
    write: true,
    input: { psid, confirm },
    handler: async ({ psid: who }, ctx) => {
      const s = store(ctx);
      return s.withLock(async () => {
        const state = await s.load(new Date());
        const existed = who in state.people;
        delete state.people[who];
        await s.save(state);
        return { reset: existed };
      });
    },
  },
];
