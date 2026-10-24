import type { ApplicantRow } from './leadout.js';

// Weekly application statistics (the owner submits to the banks once a week) and the monthly archive.
// A complete application = a finished applicant folder (passed the ID rules, bank PDFs made). "Ready" = nothing
// left to check. A week belongs to the month it starts in. Dates are this PC's local time.
// Two goals: the target (what we aim for now, e.g. 10 a week while the Page grows) and the quota (the real goal, e.g. 100).

export interface WeekStats {
  start: string; // YYYY-MM-DD, local
  end: string; // last day, YYYY-MM-DD
  complete: number;
  ready: number;
  printed: number;
  quota: number;
  target: number;
  reached: boolean;
  target_reached: boolean;
  pct_quota: number;
  pct_target: number;
  folders: string[];
}

export interface MonthStats {
  month: string; // YYYY-MM
  complete: number;
  ready: number;
  printed: number;
  /** Weekly quota/target times the weeks that start in this month. */
  quota: number;
  target: number;
  pct_quota: number;
  pct_target: number;
  weeks: WeekStats[];
}

/** Whole percent, 0 when there is nothing to divide by. */
export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Local midnight of the first day of the week that holds `d`. */
export function weekStart(d: Date, startDay: number): Date {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  s.setDate(s.getDate() - ((s.getDay() - startDay + 7) % 7));
  return s;
}

/** How many weeks start in this month (4 or 5). */
export function weeksStartingIn(month: string, startDay: number): number {
  const [y = 0, m = 1] = month.split('-').map(Number);
  let n = 0;
  for (let d = new Date(y, m - 1, 1); d.getMonth() === m - 1; d.setDate(d.getDate() + 1)) if (d.getDay() === startDay) n++;
  return n;
}

function week(start: Date, rows: ApplicantRow[], quota: number, target: number): WeekStats {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const complete = rows.length;
  return {
    start: ymd(start),
    end: ymd(end),
    complete,
    ready: rows.filter((r) => !r.missing).length,
    printed: rows.filter((r) => r.printed).length,
    quota,
    target,
    reached: complete >= quota,
    target_reached: complete >= target,
    pct_quota: pct(complete, quota),
    pct_target: pct(complete, target),
    folders: rows.map((r) => r.folder),
  };
}

export function applicationStats(rows: ApplicantRow[], opts: { quota: number; startDay: number; target?: number }, now = new Date()) {
  const target = opts.target ?? opts.quota;
  const byWeek = new Map<string, { start: Date; rows: ApplicantRow[] }>();
  for (const r of rows) {
    const t = new Date(r.completed_at);
    if (Number.isNaN(t.getTime())) continue;
    const s = weekStart(t, opts.startDay);
    const k = ymd(s);
    if (!byWeek.has(k)) byWeek.set(k, { start: s, rows: [] });
    byWeek.get(k)!.rows.push(r);
  }
  const thisStart = weekStart(now, opts.startDay);
  if (!byWeek.has(ymd(thisStart))) byWeek.set(ymd(thisStart), { start: thisStart, rows: [] });
  const weeks = [...byWeek.values()].sort((a, b) => b.start.getTime() - a.start.getTime()).map((w) => week(w.start, w.rows, opts.quota, target));

  const months = new Map<string, MonthStats>();
  for (const w of weeks) {
    const m = w.start.slice(0, 7);
    if (!months.has(m)) {
      const n = weeksStartingIn(m, opts.startDay);
      months.set(m, { month: m, complete: 0, ready: 0, printed: 0, quota: opts.quota * n, target: target * n, pct_quota: 0, pct_target: 0, weeks: [] });
    }
    const ms = months.get(m)!;
    ms.weeks.push(w);
    ms.complete += w.complete;
    ms.ready += w.ready;
    ms.printed += w.printed;
  }
  for (const ms of months.values()) {
    ms.pct_quota = pct(ms.complete, ms.quota);
    ms.pct_target = pct(ms.complete, ms.target);
  }
  const current = weeks.find((w) => w.start === ymd(thisStart))!;
  const thisMonth = current.start.slice(0, 7);
  const all = [...months.values()];
  return {
    this_week: { ...current, remaining: Math.max(current.quota - current.complete, 0), remaining_target: Math.max(current.target - current.complete, 0) },
    // Main page: the current month's weeks. Archive: every earlier month with its weeks.
    current_month: all.find((m) => m.month === thisMonth)!,
    archive: all.filter((m) => m.month < thisMonth),
  };
}

// ---- Funnel: chats → qualified → complete → approved, with % at each step --------------------------------------

export interface FunnelPerson {
  stage: string;
  started_at?: string;
  updated_at: string;
}

export interface Funnel {
  started: number;
  qualified: number; // has a card, passed the bank check, answering the questions or done
  complete: number;
  no_card: number;
  said_no: number;
  all_banks: number; // already has all our banks
  in_progress: number;
  pct_qualified: number; // of started
  pct_complete: number; // of started
  approved: number;
  declined: number;
  pending: number;
  pct_approved: number; // of decided (approved + declined)
}

const QUALIFIED = new Set(['steps', 'id_photo', 'done']);

function funnel(people: FunnelPerson[], rows: ApplicantRow[]): Funnel {
  const started = people.length;
  const qualified = people.filter((p) => QUALIFIED.has(p.stage)).length;
  const complete = rows.length;
  const approved = rows.filter((r) => r.result === 'Approved').length;
  const declined = rows.filter((r) => r.result === 'Declined').length;
  return {
    started,
    qualified,
    complete,
    no_card: people.filter((p) => p.stage === 'rejected').length,
    said_no: people.filter((p) => p.stage === 'declined').length,
    all_banks: people.filter((p) => p.stage === 'excluded').length,
    in_progress: people.filter((p) => !['done', 'rejected', 'declined', 'excluded'].includes(p.stage)).length,
    pct_qualified: pct(qualified, started),
    pct_complete: pct(complete, started),
    approved,
    declined,
    pending: complete - approved - declined,
    pct_approved: pct(approved, approved + declined),
  };
}

export const SOURCES = ['Unknown', 'Page post', 'Group', 'Referral', 'Old client', 'Friend or family', 'Other'] as const;

/** Funnel for this week, this month and all time, plus complete/approved per source (which channel converts). */
export function funnelStats(people: FunnelPerson[], rows: ApplicantRow[], startDay: number, now = new Date()) {
  const wk = weekStart(now, startDay).getTime();
  const mo = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const startedAt = (p: FunnelPerson) => new Date(p.started_at ?? p.updated_at).getTime();
  const doneAt = (r: ApplicantRow) => new Date(r.completed_at).getTime();
  const period = (from: number) =>
    funnel(
      people.filter((p) => startedAt(p) >= from),
      rows.filter((r) => doneAt(r) >= from),
    );
  const by_source = SOURCES.map((source) => {
    const rs = rows.filter((r) => (r.source || 'Unknown') === source);
    const approved = rs.filter((r) => r.result === 'Approved').length;
    const decided = approved + rs.filter((r) => r.result === 'Declined').length;
    return { source, complete: rs.length, share_pct: pct(rs.length, rows.length), approved, pct_approved: pct(approved, decided) };
  }).filter((s) => s.complete > 0);
  return { this_week: period(wk), this_month: period(mo), all_time: period(0), by_source };
}
