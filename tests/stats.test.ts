import { describe, expect, it } from 'vitest';
import type { ApplicantRow } from '../src/leadout.js';
import { applicationStats, weekStart } from '../src/stats.js';

const row = (folder: string, completed_at: string, o: Partial<ApplicantRow> = {}): ApplicantRow => ({
  folder,
  completed_at,
  name: folder,
  mobile: '',
  email: '',
  existing_cards: '',
  banks_with_pdf: '',
  flags: '',
  missing: 'TIN',
  printed: false,
  ...o,
});
// Local times (the PC's clock), like the applicant folders.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();

describe('weekly application statistics', () => {
  it('week starts on the chosen day', () => {
    const fri = new Date(2026, 9, 30, 15); // Friday Oct 30 2026
    expect(weekStart(fri, 1).getDate()).toBe(26); // Monday
    expect(weekStart(fri, 0).getDate()).toBe(25); // Sunday
    expect(weekStart(new Date(2026, 9, 26, 0, 5), 1).getDate()).toBe(26); // the start day itself
  });

  it('counts this week against the quota: complete, ready, printed, remaining', () => {
    const rows = [
      row('a', at(2026, 10, 26)),
      row('b', at(2026, 10, 27), { missing: '', printed: true }),
      row('c', at(2026, 10, 25)), // Sunday: last week when weeks start Monday
    ];
    const s = applicationStats(rows, { quota: 3, startDay: 1 }, new Date(2026, 9, 28));
    expect(s.this_week).toMatchObject({ start: '2026-10-26', end: '2026-11-01', complete: 2, ready: 1, printed: 1, quota: 3, remaining: 1, reached: false });
    const done = applicationStats([...rows, row('d', at(2026, 10, 28))], { quota: 3, startDay: 1 }, new Date(2026, 9, 28));
    expect(done.this_week).toMatchObject({ complete: 3, remaining: 0, reached: true });
  });

  it('an empty week still shows (0 of quota)', () => {
    const s = applicationStats([], { quota: 10, startDay: 1 }, new Date(2026, 9, 28));
    expect(s.this_week).toMatchObject({ complete: 0, remaining: 10 });
    expect(s.current_month.month).toBe('2026-10');
    expect(s.archive).toEqual([]);
  });

  it('earlier months go to the archive with their weeks and totals; a week belongs to the month it starts in', () => {
    const rows = [
      row('sep1', at(2026, 9, 8)),
      row('sep2', at(2026, 9, 9), { printed: true }),
      row('sep3', at(2026, 9, 29)),
      row('oct1', at(2026, 10, 3)), // Saturday: in the week of Mon Sep 28 -> September
      row('oct2', at(2026, 10, 6)),
      row('nov1', at(2026, 11, 3)),
    ];
    const s = applicationStats(rows, { quota: 2, startDay: 1 }, new Date(2026, 10, 4));
    expect(s.current_month.month).toBe('2026-11');
    expect(s.current_month.complete).toBe(1);
    expect(s.archive.map((m) => m.month)).toEqual(['2026-10', '2026-09']);
    const sep = s.archive[1]!;
    expect(sep.complete).toBe(4);
    expect(sep.printed).toBe(1);
    expect(sep.weeks.map((w) => [w.start, w.complete, w.reached])).toEqual([
      ['2026-09-28', 2, true],
      ['2026-09-07', 2, true],
    ]);
    expect(s.archive[0]!.weeks[0]!.folders).toEqual(['oct2']);
  });

  it('a bad date is skipped, not counted', () => {
    const s = applicationStats([row('x', 'not a date')], { quota: 1, startDay: 1 }, new Date(2026, 9, 28));
    expect(s.this_week.complete).toBe(0);
  });
});
