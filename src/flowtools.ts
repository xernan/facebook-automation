import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { advance, cleanSuggestions, currentPrompt, ID_TYPES, idVerdict, newPerson, nextStepIf, scriptCanAnswer, type IdSeen, type Person } from './flow.js';
import { detailsSchema } from './application.js';
import { FlowStore, loadFlow, type FlowState } from './flowstore.js';
import { finalizeLead } from './leadout.js';
import type { Ctx, ToolDef } from './tools.js';
import { botMayAnswer, loadTestMode } from './testmode.js';

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
  const tm = await loadTestMode(ctx.cfg.flowDir);
  const out = [];
  for (const conv of res.data ?? []) {
    if (new Date(conv.updated_time).getTime() < start) continue;
    const person = (conv.participants?.data ?? []).find((p: any) => p.id !== page_id);
    if (!person || !botMayAnswer(tm, person.id)) continue; // test mode: only the listed testers
    const msgs: InMsg[] = (conv.messages?.data ?? [])
      .filter((m: any) => m.from?.id === person.id)
      .map(toInMsg)
      .filter((m: InMsg) => new Date(m.created_time).getTime() >= start && !state.handled.includes(m.id))
      .reverse();
    const p = state.people[person.id];
    // ID photos saved (right away, by the watcher) but not read by Claude yet.
    const needsIdReview = p?.stage === 'id_photo' && (p.id_files?.length ?? 0) > (p.id_review?.length ?? 0);
    if (msgs.length === 0 && !p?.outbox && !needsIdReview) continue;
    const cur = p ?? newPerson(now);
    const joined = { text: msgs.map((m) => m.text).filter(Boolean).join('\n'), image_url: msgs.find((m) => m.image_url)?.image_url };
    const next = msgs.length ? nextStepIf(flow, cur, joined, now, ctx.cfg.FB_FLOW_COOLDOWN_DAYS) : undefined;
    out.push({
      psid: person.id,
      name: person.name,
      stage: cur.stage,
      current_question: currentPrompt(flow, cur),
      outbox_pending: !!p?.outbox,
      needs_id_review: needsIdReview,
      can_reply: !!msgs.at(-1) && withinWindow(ctx, msgs.at(-1)!.created_time, now),
      messages: msgs.map((m) => ({ id: m.id, text: m.text, has_image: !!m.image_url, created_time: m.created_time })),
      // If these messages answer the current question, this is asked next. When wants_suggestions is true you may
      // pass up to 5 suggestions to fb_flow_answer, ONLY from public facts you are sure of (e.g. a company branch
      // address). Never suggest personal details (names, birthplace, home address, mother's maiden name).
      next_question: next ? { key: next.key, prompt: next.prompt, wants_suggestions: !!next.suggest } : undefined,
      answers_so_far: cur.answers,
      // The watcher answers these itself in a second (no Claude): plain answers whose next question needs no search.
      script_can_answer: !p?.outbox && msgs.length > 0 && !next?.suggest && scriptCanAnswer(flow, cur, joined),
    });
  }
  return out;
}

async function send(ctx: Ctx, page_id: string, to: string, text: string, choices?: string[]) {
  if (!botMayAnswer(await loadTestMode(ctx.cfg.flowDir), to)) throw new Error('Test mode is on and this person is not a tester.');
  const message = choices?.length
    ? { text, quick_replies: choices.map((c) => ({ content_type: 'text', title: c, payload: c })) }
    : { text };
  await ctx.graph.post(page_id, `${page_id}/messages`, {
    recipient: JSON.stringify({ id: to }),
    message: JSON.stringify(message),
    messaging_type: 'RESPONSE',
  });
}

/**
 * Saves the reply in the person's outbox, sends it, then marks the messages handled. If sending fails the
 * outbox stays and the next fb_flow_answer resends it; a maybe-sent reply is never sent twice.
 */
async function deliver(
  ctx: Ctx,
  s: FlowStore,
  state: FlowState,
  page_id: string,
  who: string,
  person: Person,
  text: string,
  choices: string[] | undefined,
  ids: string[],
  extra: Record<string, unknown> = {},
) {
  person.outbox = { text, for_messages: ids, choices };
  state.people[who] = person;
  await s.save(state);
  try {
    await send(ctx, page_id, who, text, choices);
  } catch (err: any) {
    if (!err?.uncertain) throw err;
    delete person.outbox;
    markHandled(state, ids);
    await s.save(state);
    return { reply: text, stage: person.stage, ...extra, note: 'Send may not have gone through. Check the chat with fb_get_messages.' };
  }
  delete person.outbox;
  markHandled(state, ids);
  await s.save(state);
  return { reply: text, buttons: choices, stage: person.stage, ...extra };
}

const idSeen = z
  .object({
    type: z.enum(ID_TYPES),
    side: z.enum(['front', 'back', 'both']),
    clear: z.boolean().describe('Readable, whole (no cut edges), nothing covering it'),
    has_signature: z.boolean(),
    name: z.string().max(120).optional(),
    birthday: z.string().max(20).optional().describe('As printed, e.g. 1990-05-31'),
    sex: z.string().max(10).optional(),
  })
  .strict();

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
      suggestions: z
        .array(z.string().max(200))
        .max(5)
        .optional()
        .describe('For the next question only, when fb_flow_pending says wants_suggestions. Public facts you are sure of; never guess.'),
    },
    handler: async ({ page_id, psid: who, message_ids, kind, suggestions }, ctx) => {
      const now = new Date();
      const s = store(ctx);
      const flow = loadFlow(ctx.cfg.flowFile);
      return s.withLock(async () => {
        const state = await s.load(now);
        const person = state.people[who] ?? newPerson(now);

        // A reply that failed to send earlier goes first, exactly once.
        if (person.outbox) {
          await send(ctx, page_id, who, person.outbox.text, person.outbox.choices);
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
        const r = advance(flow, person, input, now, ctx.cfg.FB_FLOW_COOLDOWN_DAYS, cleanSuggestions(suggestions));
        const next: Person = r.person;

        if (r.received_id_image) {
          const file = await s.saveIdImage(who, r.received_id_image, now, ctx.cfg.FB_FLOW_MAX_IMAGE_MB * 1024 * 1024, ctx.cfg.FB_HTTP_TIMEOUT_MS);
          if (!file) return deliver(ctx, s, state, page_id, who, next, flow.id_photo.unclear_reply, undefined, ids);
          next.id_files = [...(next.id_files ?? []), file];
          markHandled(state, ids);
          state.people[who] = next;
          await s.save(state);
          return {
            reply: null,
            stage: next.stage,
            needs_id_review: true,
            id_photos: next.id_files.length,
            note: 'Look at every ID photo with fb_flow_id_images, then call fb_flow_id_review.',
          };
        }

        if (!r.reply) {
          markHandled(state, ids);
          state.people[who] = next;
          await s.save(state);
          return { reply: null, stage: next.stage };
        }
        return deliver(ctx, s, state, page_id, who, next, r.reply, r.choices, ids);
      });
    },
  },
  {
    name: 'fb_flow_id_images',
    description:
      'The ID photos one applicant sent, as images, in order. Read each one (type, side, clear, signature, name, birthday, sex) ' +
      'and pass what you see to fb_flow_id_review. Personal data: never paste it anywhere public.',
    write: false,
    input: { psid },
    handler: async ({ psid: who }, ctx) => {
      const state = await store(ctx).load(new Date());
      const files = state.people[who]?.id_files ?? [];
      if (files.length === 0) return { note: 'No ID photos yet.' };
      const root = path.resolve(ctx.cfg.flowDir) + path.sep;
      const content = [];
      for (const [i, f] of files.entries()) {
        const full = path.resolve(ctx.cfg.flowDir, f);
        if (!full.startsWith(root)) continue;
        const mimeType = f.endsWith('.png') ? 'image/png' : f.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
        content.push({ type: 'text', text: `Photo ${i}` }, { type: 'image', data: (await fsp.readFile(full)).toString('base64'), mimeType });
      }
      return { __content: content };
    },
  },
  {
    name: 'fb_flow_id_review',
    description:
      'After looking at the ID photos (fb_flow_id_images), report what each photo shows, one entry per photo in the same order. ' +
      'The owner ID rules are applied in code: if the set is enough the application completes and the lead is saved; otherwise ' +
      'the applicant is told exactly what is missing (clearer photo, back side, second ID, ID with signature, primary ID). ' +
      'clear=false if blurry, cut off, covered or glaring. Use type "other" for anything not listed. Never guess a field you cannot read.',
    write: true,
    input: { page_id: pageId, psid, photos: z.array(idSeen).min(1).max(10) },
    handler: async ({ page_id, psid: who, photos }, ctx) => {
      const now = new Date();
      const s = store(ctx);
      const flow = loadFlow(ctx.cfg.flowFile);
      return s.withLock(async () => {
        const state = await s.load(now);
        const person = state.people[who];
        if (!person || person.stage !== 'id_photo') throw new Error('This person is not at the ID photo step.');
        const n = (person.id_files ?? []).length;
        if (photos.length !== n) throw new Error(`Give one entry per ID photo: there are ${n}.`);
        person.id_review = photos as IdSeen[];
        const v = idVerdict(flow, person.id_review);
        if (!v.ok) return deliver(ctx, s, state, page_id, who, person, v.reply, undefined, [], { id_ok: false });
        person.stage = 'done';
        const leadFile = await s.saveLead(who, person, now);
        return deliver(ctx, s, state, page_id, who, person, flow.done_reply, undefined, [], { id_ok: true, lead_saved: leadFile });
      });
    },
  },
  {
    name: 'fb_lead_finalize',
    description:
      'After an application completes (lead_saved), make the bank PDFs, copy the IDs into the applicant folder and update ' +
      'CLIENTS.xlsx. Pass what you READ on the ID photos (names, birthday, sex, nationality, ID number, TIN only if printed on ' +
      'an ID) and what you split or looked up (home and office address parts, zip codes, office phone with its source, nature ' +
      'of business, department, employment type). Leave out anything you are not sure of: it is listed as missing. Never invent ' +
      'income, TIN, SSS or other personal facts. Returns the missing list to follow up.',
    write: false,
    input: {
      lead_file: z.string().regex(/^lead-\d+-[\w-]+\.json$/, 'Use lead_saved exactly as returned'),
      details: detailsSchema,
    },
    handler: ({ lead_file, details }, ctx) => finalizeLead(ctx.cfg.flowDir, ctx.cfg.templatesDir, lead_file, details),
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
