import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentProblem } from '../src/contentguard.js';
import { initialOf, postStats, proofDraft, setOutcome } from '../src/marketing.js';

describe('marketing', () => {
  it('saves the bank result and keeps the first consent date; withdrawing clears it', async () => {
    const f = path.join(mkdtempSync(path.join(tmpdir(), 'mk-')), 'details.json');
    writeFileSync(f, JSON.stringify({ data: { full_name: 'Juan Dela Cruz' } }));
    await setOutcome(f, { result: 'Approved', card: 'Metrobank Titanium', proof_ok: true }, new Date('2026-11-01T00:00:00Z'));
    await setOutcome(f, { result: 'Approved', card: 'Metrobank Titanium', proof_ok: true }, new Date('2026-11-05T00:00:00Z'));
    expect(JSON.parse(readFileSync(f, 'utf8')).outcome.proof_ok_at).toBe('2026-11-01T00:00:00.000Z');
    await setOutcome(f, { result: 'Approved', card: 'Metrobank Titanium', proof_ok: false });
    expect(JSON.parse(readFileSync(f, 'utf8')).outcome.proof_ok_at).toBeUndefined();
    await expect(setOutcome(f, { result: 'Maybe' })).rejects.toThrow();
    await expect(setOutcome(f, { result: 'Approved', card: 'x'.repeat(61) })).rejects.toThrow();
  });

  it('a thank-you post needs Approved + the client OK + the card, shows only an initial, and passes the guard', () => {
    expect(initialOf('juan dela cruz')).toBe('J.');
    expect(proofDraft({ name: 'Juan Dela Cruz', result: 'Approved', card: 'Metrobank Titanium', proof_ok: false })).toBeUndefined();
    expect(proofDraft({ name: 'Juan Dela Cruz', result: 'Pending', card: 'Metrobank Titanium', proof_ok: true })).toBeUndefined();
    expect(proofDraft({ name: 'Juan Dela Cruz', result: 'Approved', proof_ok: true })).toBeUndefined();
    const d = proofDraft({ name: 'Juan Dela Cruz', result: 'Approved', card: 'Metrobank Titanium', proof_ok: true })!;
    expect(d).toContain('J.!');
    expect(d).not.toMatch(/Juan|Cruz/);
    expect(contentProblem(d)).toBeUndefined();
    // A card name that breaks a rule gives no draft.
    expect(proofDraft({ name: 'Juan', result: 'Approved', card: 'Guaranteed card', proof_ok: true })).toBeUndefined();
  });

  it('post stats flag duplicates and rule breaks', async () => {
    const graph = {
      get: async (_p: string, path: string) =>
        path.endsWith('/posts')
          ? {
              data: [
                { id: '1', message: 'Same  text', created_time: '2026-10-01', reactions: { summary: { total_count: 3 } }, comments: { summary: { total_count: 1 } }, shares: { count: 2 } },
                { id: '2', message: 'same text', created_time: '2026-10-02' },
                { id: '3', message: 'TAG ang isang kaibigan!', created_time: '2026-10-03' },
              ],
            }
          : { data: [{ id: 's', message: 'Hello', scheduled_publish_time: 1793000000 }] },
    };
    const r = await postStats(graph, '1');
    expect(r.posts.map((p) => p.duplicate)).toEqual([true, true, false]);
    expect(r.posts[0]).toMatchObject({ reactions: 3, comments: 1, shares: 2 });
    expect(r.posts[2].problem).toMatch(/engagement bait/);
    expect(r.scheduled[0].problem).toBeUndefined();
  });
});
