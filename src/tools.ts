import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { Config } from './config.js';
import { leadsToCsv, resolveMediaFile, writeExport, type Lead } from './files.js';
import { GraphClient, type Params } from './graph.js';
import { IdempotencyStore } from './idempotency.js';
import { contactLeadsToCsv, leadFromComment, leadFromConversation, type ContactLead } from './leads.js';
import { toScheduleTimestamp } from './schedule.js';

export interface Ctx {
  cfg: Config;
  graph: GraphClient;
  idem: IdempotencyStore;
}

export interface ToolDef {
  name: string;
  description: string;
  write: boolean;
  input: z.ZodRawShape;
  handler: (args: any, ctx: Ctx) => Promise<unknown>;
}

// ---- shared input pieces -------------------------------------------------
const id = z.string().regex(/^[0-9_]+$/, 'Must be a numeric Facebook id');
const pageId = id.describe('Page id from fb_list_pages');
const limit = z.number().int().min(1).max(100).optional().describe('Items per page (max set by FB_MAX_LIST_LIMIT)');
// Meta cursors are URL-safe base64 and can run past 1,000 characters.
const after = z
  .string()
  .max(4000)
  .regex(/^[A-Za-z0-9_\-=%]+$/, 'Use next_cursor exactly as returned')
  .optional()
  .describe('next_cursor from a previous call');
const text = (max: number) => z.string().trim().min(1).max(max);
const idemKey = z
  .string()
  .min(8)
  .max(100)
  .optional()
  .describe('Unique key for this action. Reuse it when retrying so the action is not done twice.');
const scheduled = z
  .string()
  .optional()
  .describe('ISO date-time with timezone to schedule instead of publishing now, e.g. 2026-11-01T09:00:00+08:00');
const confirm = z.literal(true).describe('Must be true. Confirms this cannot be undone.');

const lim = (ctx: Ctx, n?: number) => Math.min(n ?? 25, ctx.cfg.FB_MAX_LIST_LIMIT);
const page = (res: any) => ({ data: res.data ?? [], next_cursor: res.paging?.next ? res.paging?.cursors?.after : undefined });

/** Post ids look like "<pageId>_<postId>"; refuse ids that belong to another page. */
function assertOwnPost(pageIdValue: string, postId: string) {
  if (postId.includes('_') && !postId.startsWith(`${pageIdValue}_`)) {
    throw new Error('This post does not belong to the given page.');
  }
}

function scheduleParams(ctx: Ctx, iso?: string): Params {
  if (!iso) return {};
  return {
    published: false,
    scheduled_publish_time: toScheduleTimestamp(iso, ctx.cfg.FB_SCHEDULE_MIN_MINUTES, ctx.cfg.FB_SCHEDULE_MAX_DAYS),
  };
}

const POST_FIELDS = 'id,message,created_time,permalink_url,status_type,is_published,scheduled_publish_time';

export const tools: ToolDef[] = [
  // ---- pages ---------------------------------------------------------------
  {
    name: 'fb_list_pages',
    description: 'List the Facebook Pages this token can manage, with the tasks allowed on each.',
    write: false,
    input: { refresh: z.boolean().optional() },
    handler: async ({ refresh }, { graph }) =>
      (await graph.listPages(refresh)).map(({ id, name, tasks }) =>
        // Business-owned Pages come from a direct lookup, which returns no tasks; they still work.
        tasks ? { id, name, tasks } : { id, name, access: 'Business Page: full access through its Page token (Meta lists no tasks)' },
      ),
  },
  {
    name: 'fb_get_page',
    description: 'Get Page details: name, about, category, followers, contact info, website.',
    write: false,
    input: { page_id: pageId },
    handler: ({ page_id }, { graph }) =>
      graph.get(page_id, page_id, {
        fields: 'id,name,about,description,category,fan_count,followers_count,link,phone,emails,website,single_line_address,hours',
      }),
  },
  {
    name: 'fb_update_page_info',
    description: 'Update Page info fields (about, description, phone, website). Only the fields given are changed.',
    write: true,
    input: {
      page_id: pageId,
      about: z.string().max(255).optional(),
      description: z.string().max(5000).optional(),
      phone: z.string().max(40).optional(),
      website: z.url().max(500).optional(),
    },
    handler: ({ page_id, ...fields }, { graph }) => {
      const params = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Params;
      if (Object.keys(params).length === 0) throw new Error('Give at least one field to update.');
      return graph.post(page_id, page_id, params);
    },
  },

  // ---- posts ---------------------------------------------------------------
  {
    name: 'fb_list_posts',
    description: 'List published Page posts, newest first. Set scheduled=true to list scheduled (not yet published) posts.',
    write: false,
    input: { page_id: pageId, scheduled: z.boolean().optional(), limit, after },
    handler: async ({ page_id, scheduled: sched, limit: n, after: a }, ctx) =>
      page(
        await ctx.graph.get(page_id, `${page_id}/${sched ? 'scheduled_posts' : 'posts'}`, {
          fields: POST_FIELDS,
          limit: lim(ctx, n),
          after: a,
        }),
      ),
  },
  {
    name: 'fb_get_post',
    description: 'Get one post with reaction, comment and share counts.',
    write: false,
    input: { page_id: pageId, post_id: id },
    handler: ({ page_id, post_id }, { graph }) => {
      assertOwnPost(page_id, post_id);
      return graph.get(page_id, post_id, {
        fields: `${POST_FIELDS},shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)`,
      });
    },
  },
  {
    name: 'fb_create_post',
    description: 'Publish (or schedule) a text and/or link post on the Page.',
    write: true,
    input: {
      page_id: pageId,
      message: z.string().max(63206).optional(),
      link: z.url().max(2000).optional(),
      scheduled_time: scheduled,
      idempotency_key: idemKey,
    },
    handler: async ({ page_id, message, link, scheduled_time }, ctx) => {
      if (!message && !link) throw new Error('Give a message, a link, or both.');
      const params = { message, link, ...scheduleParams(ctx, scheduled_time) };
      return ctx.graph.post(page_id, `${page_id}/feed`, params);
    },
  },
  {
    name: 'fb_create_photo_post',
    description:
      'Publish (or schedule) a photo post. Use image_url for a public image, or image_file for a file inside the media folder.',
    write: true,
    input: {
      page_id: pageId,
      image_url: z.url().max(2000).optional(),
      image_file: z.string().max(260).optional().describe('File name or sub-path inside the media folder'),
      caption: z.string().max(63206).optional(),
      scheduled_time: scheduled,
      idempotency_key: idemKey,
    },
    handler: async ({ page_id, image_url, image_file, caption, scheduled_time }, ctx) => {
      if (!!image_url === !!image_file) throw new Error('Give exactly one of image_url or image_file.');
      const params: Params = { caption, ...scheduleParams(ctx, scheduled_time) };
      if (image_url) return ctx.graph.post(page_id, `${page_id}/photos`, { ...params, url: image_url });
      const f = await resolveMediaFile(ctx.cfg.mediaDir, image_file, ctx.cfg.FB_MAX_UPLOAD_MB * 1048576);
      const form = new FormData();
      form.set('source', new Blob([await fs.readFile(f.full)], { type: f.mime }), f.name);
      for (const [k, v] of Object.entries(params)) if (v !== undefined) form.set(k, String(v));
      return ctx.graph.post(page_id, `${page_id}/photos`, {}, form);
    },
  },
  {
    name: 'fb_create_video_post',
    description: 'Publish (or schedule) a video from a public video URL.',
    write: true,
    input: {
      page_id: pageId,
      video_url: z.url().max(2000),
      title: z.string().max(255).optional(),
      description: z.string().max(63206).optional(),
      scheduled_time: scheduled,
      idempotency_key: idemKey,
    },
    handler: ({ page_id, video_url, title, description, scheduled_time }, ctx) =>
      ctx.graph.post(page_id, `${page_id}/videos`, {
        file_url: video_url,
        title,
        description,
        ...scheduleParams(ctx, scheduled_time),
      }),
  },
  {
    name: 'fb_update_post',
    description: 'Edit the text of an existing Page post.',
    write: true,
    input: { page_id: pageId, post_id: id, message: text(63206) },
    handler: ({ page_id, post_id, message }, { graph }) => {
      assertOwnPost(page_id, post_id);
      return graph.post(page_id, post_id, { message });
    },
  },
  {
    name: 'fb_delete_post',
    description: 'Delete a Page post (also cancels a scheduled post). Cannot be undone.',
    write: true,
    input: { page_id: pageId, post_id: id, confirm },
    handler: ({ page_id, post_id }, { graph }) => {
      assertOwnPost(page_id, post_id);
      return graph.del(page_id, post_id);
    },
  },

  // ---- comments ------------------------------------------------------------
  {
    name: 'fb_list_comments',
    description: 'List comments on a post (or replies on a comment), newest first.',
    write: false,
    input: { page_id: pageId, object_id: id.describe('Post id or comment id'), limit, after },
    handler: async ({ page_id, object_id, limit: n, after: a }, ctx) =>
      page(
        await ctx.graph.get(page_id, `${object_id}/comments`, {
          fields: 'id,from,message,created_time,is_hidden,can_hide,comment_count,like_count,permalink_url',
          order: 'reverse_chronological',
          filter: 'stream',
          limit: lim(ctx, n),
          after: a,
        }),
      ),
  },
  {
    name: 'fb_reply_comment',
    description: 'Reply publicly as the Page to a comment, or comment on a post.',
    write: true,
    input: { page_id: pageId, object_id: id.describe('Comment id to reply to, or post id'), message: text(8000), idempotency_key: idemKey },
    handler: ({ page_id, object_id, message }, ctx) => ctx.graph.post(page_id, `${object_id}/comments`, { message }),
  },
  {
    name: 'fb_hide_comment',
    description: 'Hide or unhide a comment on a Page post (hidden comments stay visible to the author and their friends).',
    write: true,
    input: { page_id: pageId, comment_id: id, hidden: z.boolean() },
    handler: ({ page_id, comment_id, hidden }, { graph }) => graph.post(page_id, comment_id, { is_hidden: hidden }),
  },
  {
    name: 'fb_delete_comment',
    description: 'Delete a comment on a Page post. Cannot be undone.',
    write: true,
    input: { page_id: pageId, comment_id: id, confirm },
    handler: ({ page_id, comment_id }, { graph }) => graph.del(page_id, comment_id),
  },

  // ---- messenger -----------------------------------------------------------
  {
    name: 'fb_list_conversations',
    description: 'List Messenger conversations of the Page, most recent first.',
    write: false,
    input: { page_id: pageId, limit, after },
    handler: async ({ page_id, limit: n, after: a }, ctx) =>
      page(
        await ctx.graph.get(page_id, `${page_id}/conversations`, {
          platform: 'messenger',
          fields: 'id,updated_time,unread_count,message_count,snippet,participants',
          limit: lim(ctx, n),
          after: a,
        }),
      ),
  },
  {
    name: 'fb_get_messages',
    description: 'Read messages in one Messenger conversation, newest first.',
    write: false,
    input: { page_id: pageId, conversation_id: z.string().regex(/^t_[A-Za-z0-9_-]+$/), limit, after },
    handler: async ({ page_id, conversation_id, limit: n, after: a }, ctx) =>
      page(
        await ctx.graph.get(page_id, `${conversation_id}/messages`, {
          fields: 'id,message,from,to,created_time,attachments',
          limit: lim(ctx, n),
          after: a,
        }),
      ),
  },
  {
    name: 'fb_send_message',
    description:
      'Send a Messenger message as the Page. Use recipient_psid for someone who messaged the Page (within 24 hours), ' +
      'or comment_id to send one private reply to a person who commented on a Page post.',
    write: true,
    input: {
      page_id: pageId,
      recipient_psid: id.optional(),
      comment_id: id.optional(),
      text: text(2000),
      message_tag: z
        .enum(['HUMAN_AGENT', 'ACCOUNT_UPDATE', 'CONFIRMED_EVENT_UPDATE', 'POST_PURCHASE_UPDATE'])
        .optional()
        .describe('Only for allowed cases outside the 24-hour window. Never for promotions.'),
      idempotency_key: idemKey,
    },
    handler: ({ page_id, recipient_psid, comment_id, text: body, message_tag }, ctx) => {
      if (!!recipient_psid === !!comment_id) throw new Error('Give exactly one of recipient_psid or comment_id.');
      const params: Params = {
        recipient: JSON.stringify(recipient_psid ? { id: recipient_psid } : { comment_id }),
        message: JSON.stringify({ text: body }),
        messaging_type: message_tag ? 'MESSAGE_TAG' : 'RESPONSE',
        tag: message_tag,
      };
      return ctx.graph.post(page_id, `${page_id}/messages`, params);
    },
  },

  // ---- insights & reviews --------------------------------------------------
  {
    name: 'fb_page_insights',
    description:
      'Page insights for given metric names (e.g. page_total_media_view_unique = reach, page_media_view, page_post_engagements, ' +
      'page_follows, page_views_total). ' +
      'Meta renames metrics between versions; if one fails, check the Page Insights docs for the current name.',
    write: false,
    input: {
      page_id: pageId,
      metrics: z.array(z.string().regex(/^[a-z0-9_]+$/)).min(1).max(20),
      period: z.enum(['day', 'week', 'days_28', 'month', 'lifetime', 'total_over_range']).optional(),
      since: z.iso.date().optional().describe('YYYY-MM-DD'),
      until: z.iso.date().optional().describe('YYYY-MM-DD'),
    },
    handler: ({ page_id, metrics, period, since, until }, { graph }) =>
      graph.get(page_id, `${page_id}/insights`, { metric: metrics.join(','), period: period ?? 'day', since, until }),
  },
  {
    name: 'fb_post_insights',
    description: 'Insights for one post (e.g. post_total_media_view_unique = reach, post_media_view, post_clicks, post_reactions_by_type_total).',
    write: false,
    input: { page_id: pageId, post_id: id, metrics: z.array(z.string().regex(/^[a-z0-9_]+$/)).min(1).max(20) },
    handler: ({ page_id, post_id, metrics }, { graph }) => {
      assertOwnPost(page_id, post_id);
      return graph.get(page_id, `${post_id}/insights`, { metric: metrics.join(',') });
    },
  },
  {
    name: 'fb_list_reviews',
    description: 'List Page reviews/recommendations.',
    write: false,
    input: { page_id: pageId, limit, after },
    handler: async ({ page_id, limit: n, after: a }, ctx) =>
      page(
        await ctx.graph.get(page_id, `${page_id}/ratings`, {
          fields: 'reviewer,recommendation_type,review_text,created_time,open_graph_story',
          limit: lim(ctx, n),
          after: a,
        }),
      ),
  },

  // ---- lead ads ------------------------------------------------------------
  {
    name: 'fb_list_lead_forms',
    description: 'List the Lead Ads instant forms of the Page with their lead counts.',
    write: false,
    input: { page_id: pageId, limit, after },
    handler: async ({ page_id, limit: n, after: a }, ctx) =>
      page(
        await ctx.graph.get(page_id, `${page_id}/leadgen_forms`, {
          fields: 'id,name,status,leads_count,created_time,locale',
          limit: lim(ctx, n),
          after: a,
        }),
      ),
  },
  {
    name: 'fb_get_leads',
    description:
      'Get leads from a Lead Ads form. Set export_csv=true to also save them as a CSV in the exports folder ' +
      '(fetches every page of results, up to max_leads). Leads are personal data: do not paste them anywhere public.',
    write: false,
    input: {
      page_id: pageId,
      form_id: id,
      since: z.iso.datetime({ offset: true }).optional().describe('Only leads created after this ISO date-time'),
      max_leads: z.number().int().min(1).max(10000).optional(),
      export_csv: z.boolean().optional(),
    },
    handler: async ({ page_id, form_id, since, max_leads, export_csv }, ctx) => {
      const max = max_leads ?? 500;
      const leads: Lead[] = [];
      let cursor: string | undefined;
      do {
        const res: any = await ctx.graph.get(page_id, `${form_id}/leads`, {
          fields: 'id,created_time,ad_id,form_id,field_data',
          limit: Math.min(ctx.cfg.FB_MAX_LIST_LIMIT, max - leads.length),
          after: cursor,
          filtering: since
            ? JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(Date.parse(since) / 1000) }])
            : undefined,
        });
        leads.push(...(res.data ?? []));
        cursor = res.paging?.next ? res.paging?.cursors?.after : undefined;
      } while (cursor && leads.length < max);
      const file = export_csv ? await writeExport(ctx.cfg.exportDir, `leads_${form_id}`, leadsToCsv(leads)) : undefined;
      return { count: leads.length, csv_file: file, leads };
    },
  },

  // ---- leads from Messenger and comments -----------------------------------
  {
    name: 'fb_messenger_leads',
    description:
      'Find leads among people who messaged the Page: name, phone and email they typed, banks/cards they asked about, ' +
      'carded or not, last message. Everyone who messaged is a lead; no keyword needed. ' +
      'Newest first. Set export_csv=true to save a CSV in the exports folder. Personal data: do not paste it anywhere public.',
    write: false,
    input: {
      page_id: pageId,
      since: z.iso.datetime({ offset: true }).optional().describe('Only conversations active after this ISO date-time'),
      only_with_contact: z.boolean().optional().describe('Only people who shared a phone or email'),
      export_csv: z.boolean().optional(),
    },
    handler: async ({ page_id, since, only_with_contact, export_csv }, ctx) => {
      const max = ctx.cfg.FB_LEADS_SCAN_MAX;
      const sinceMs = since ? Date.parse(since) : undefined;
      const leads: ContactLead[] = [];
      let scanned = 0;
      let cursor: string | undefined;
      scan: do {
        const res: any = await ctx.graph.get(page_id, `${page_id}/conversations`, {
          platform: 'messenger',
          fields: `id,updated_time,snippet,participants,messages.limit(${ctx.cfg.FB_LEADS_MESSAGES_PER_CHAT}){message,from,created_time}`,
          limit: Math.min(ctx.cfg.FB_MAX_LIST_LIMIT, ctx.cfg.FB_LEADS_CHATS_PER_PAGE),
          after: cursor,
        });
        for (const conv of res.data ?? []) {
          if (sinceMs !== undefined && Date.parse(conv.updated_time) < sinceMs) break scan;
          if (++scanned > max) break scan;
          const lead = leadFromConversation(page_id, conv);
          if (lead && (!only_with_contact || lead.phones.length || lead.emails.length)) leads.push(lead);
        }
        cursor = res.paging?.next ? res.paging?.cursors?.after : undefined;
      } while (cursor);
      const file = export_csv ? await writeExport(ctx.cfg.exportDir, 'messenger_leads', contactLeadsToCsv(leads)) : undefined;
      return { scanned: Math.min(scanned, max), count: leads.length, csv_file: file, leads };
    },
  },
  {
    name: 'fb_comment_leads',
    description:
      'Find leads among people who commented on Page posts: name, comment, phone/email typed, banks named, carded or not. ' +
      'Every commenter is a lead unless keywords are given. ' +
      'Scans one post, or the newest posts. Use the comment id with fb_send_message (comment_id) for one private reply. ' +
      'Personal data: do not paste it anywhere public.',
    write: false,
    input: {
      page_id: pageId,
      post_id: id.optional().describe('Only this post. Default: the newest posts (FB_LEADS_SCAN_POSTS)'),
      keywords: z.array(z.string().trim().min(1).max(50)).max(20).optional().describe('Only comments containing one of these words'),
      since: z.iso.datetime({ offset: true }).optional().describe('Only comments after this ISO date-time'),
      only_with_contact: z.boolean().optional(),
      export_csv: z.boolean().optional(),
    },
    handler: async ({ page_id, post_id, keywords, since, only_with_contact, export_csv }, ctx) => {
      if (post_id) assertOwnPost(page_id, post_id);
      const postIds: string[] = post_id
        ? [post_id]
        : ((await ctx.graph.get(page_id, `${page_id}/posts`, { fields: 'id', limit: ctx.cfg.FB_LEADS_SCAN_POSTS })).data ?? []).map(
            (p: any) => p.id,
          );
      const sinceMs = since ? Date.parse(since) : undefined;
      const words = (keywords ?? []).map((k: string) => k.toLowerCase());
      const leads: ContactLead[] = [];
      let scanned = 0;
      let postsScanned = 0;
      scan: for (const pid of postIds) {
        postsScanned++;
        let cursor: string | undefined;
        do {
          const res: any = await ctx.graph.get(page_id, `${pid}/comments`, {
            fields: 'id,from,message,created_time',
            filter: 'stream',
            order: 'reverse_chronological',
            limit: ctx.cfg.FB_MAX_LIST_LIMIT,
            after: cursor,
          });
          for (const c of res.data ?? []) {
            if (++scanned > ctx.cfg.FB_LEADS_SCAN_MAX) break scan;
            if (sinceMs !== undefined && Date.parse(c.created_time) < sinceMs) continue;
            if (words.length && !words.some((w: string) => (c.message ?? '').toLowerCase().includes(w))) continue;
            const lead = leadFromComment(page_id, pid, c);
            if (lead && (!only_with_contact || lead.phones.length || lead.emails.length)) leads.push(lead);
          }
          cursor = res.paging?.next ? res.paging?.cursors?.after : undefined;
        } while (cursor);
      }
      const file = export_csv ? await writeExport(ctx.cfg.exportDir, 'comment_leads', contactLeadsToCsv(leads)) : undefined;
      return { posts_scanned: postsScanned, count: leads.length, csv_file: file, leads };
    },
  },

  // ---- escape hatch --------------------------------------------------------
  {
    name: 'fb_graph_get',
    description:
      'Read-only Graph API GET for anything the other tools do not cover (e.g. "<page_id>/tagged", "<post_id>/attachments"). ' +
      'Uses the token of the given page.',
    write: false,
    input: {
      page_id: pageId,
      path: z
        .string()
        .max(300)
        .regex(/^[A-Za-z0-9_\-./]+$/, 'Plain path only, no query string or full URL')
        .refine((p) => !p.includes('..'), 'No ".." in path'),
      params: z
        .record(z.string().regex(/^[a-z_]+$/), z.string().max(2000))
        .optional()
        .refine(
          (p) => !p || !Object.entries(p).some(([k, v]) => /token|secret|proof/i.test(`${k} ${v}`)),
          'Auth params and token fields are not allowed',
        ),
    },
    handler: ({ page_id, path, params }, { graph }) => graph.get(page_id, path, params),
  },
];

export async function callTool(def: ToolDef, args: unknown, ctx: Ctx) {
  if (def.write && !ctx.cfg.FB_WRITE_ENABLED) {
    throw new Error('Write actions are turned off. Set FB_WRITE_ENABLED=true in .env and restart Claude to allow them.');
  }
  const parsed = z.object(def.input).strict().parse(args);
  // Tools that take idempotency_key run once per key; the same key with other args is refused.
  if ('idempotency_key' in def.input) {
    const { idempotency_key, ...rest } = parsed;
    return ctx.idem.run(idempotency_key as string | undefined, () => def.handler(parsed, ctx), JSON.stringify([def.name, rest]));
  }
  return def.handler(parsed, ctx);
}
