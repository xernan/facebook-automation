import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { contentProblem } from './contentguard.js';

// Marketing helpers for the dashboard: bank result + proof-post consent per applicant, and how our Page posts do.
// Proof posts ("Approved: <card>, salamat Ms. J.!") are the posts that grew the agent pages we studied; they need
// the client's OK and show only a first-name initial, never their ID, card or face.

export const outcomeSchema = z.object({
  result: z.enum(['Pending', 'Approved', 'Declined']),
  card: z.string().trim().max(60).optional(),
  proof_ok: z.boolean().default(false),
});
export type Outcome = z.infer<typeof outcomeSchema>;

/** Saves the bank result and the proof-post consent in the applicant's details.json. */
export async function setOutcome(file: string, input: unknown, now = new Date()): Promise<void> {
  const o = outcomeSchema.parse(input);
  const d = JSON.parse(await fs.readFile(file, 'utf8'));
  const prev = d.outcome ?? {};
  d.outcome = {
    result: o.result,
    card: o.card || undefined,
    proof_ok: o.proof_ok,
    // Keep the date they first said yes; clear it when the OK is withdrawn.
    proof_ok_at: o.proof_ok ? (prev.proof_ok_at ?? now.toISOString()) : undefined,
    updated_at: now.toISOString(),
  };
  await fs.writeFile(file, JSON.stringify(d, null, 2), 'utf8');
}

/** "Ms. J." style: first-name initial only. */
export function initialOf(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? '';
  return first ? `${first.charAt(0).toUpperCase()}.` : '';
}

/** Draft proof post, or undefined when the applicant is not approved, gave no OK, or the text would break a rule. */
export function proofDraft(a: { name: string; result?: string; card?: string; proof_ok?: boolean }): string | undefined {
  if (a.result !== 'Approved' || !a.proof_ok || !a.card) return undefined;
  const text = `Approved: ${a.card} ✅\n\nSalamat sa tiwala, ${initialOf(a.name)}! May credit card ka na at gusto mo ng isa pa? Libre ang tulong namin sa pag-apply. Mag-message lang sa CARD MAX.\n\nAng bangko pa rin ang nagdedesisyon sa approval.`;
  return contentProblem(text) ? undefined : text;
}

export interface PostStat {
  id: string;
  created_time: string;
  text: string;
  permalink_url?: string;
  reactions: number;
  comments: number;
  shares: number;
  duplicate: boolean;
  problem?: string;
}

type Getter = { get(pageId: string, path: string, params?: Record<string, string>): Promise<any> };

/** Recent Page posts with reactions/comments/shares, plus flags: same text posted twice, or text that breaks a rule. */
export async function postStats(graph: Getter, pageId: string, limit = 25): Promise<{ posts: PostStat[]; scheduled: { id: string; when: string; text: string; problem?: string }[] }> {
  const [pub, sch] = await Promise.all([
    graph.get(pageId, `${pageId}/posts`, {
      fields: 'id,message,created_time,permalink_url,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)',
      limit: String(limit),
    }),
    graph.get(pageId, `${pageId}/scheduled_posts`, { fields: 'id,message,scheduled_publish_time', limit: '50' }).catch(() => ({ data: [] })),
  ]);
  const seen = new Map<string, number>();
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const p of pub.data ?? []) if (p.message) seen.set(norm(p.message), (seen.get(norm(p.message)) ?? 0) + 1);
  const posts = (pub.data ?? []).map((p: any) => ({
    id: p.id,
    created_time: p.created_time,
    text: String(p.message ?? '').slice(0, 300),
    permalink_url: p.permalink_url,
    reactions: p.reactions?.summary?.total_count ?? 0,
    comments: p.comments?.summary?.total_count ?? 0,
    shares: p.shares?.count ?? 0,
    duplicate: !!p.message && (seen.get(norm(p.message)) ?? 0) > 1,
    problem: p.message ? contentProblem(p.message) : undefined,
  }));
  const scheduled = (sch.data ?? []).map((p: any) => ({
    id: p.id,
    when: new Date(Number(p.scheduled_publish_time) * 1000).toISOString(),
    text: String(p.message ?? '').slice(0, 300),
    problem: p.message ? contentProblem(p.message) : undefined,
  }));
  return { posts, scheduled };
}
