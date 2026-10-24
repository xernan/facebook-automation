import type { ApplicantRow } from './leadout.js';

// Weekly application statistics (the owner submits to the banks once a week) and the monthly archive.
// A complete application = a finished applicant folder (passed the ID rules, bank PDFs made). "Ready" = nothing
// left to check. A week belongs to the month it starts in. Dates are this PC's local time.

export interface WeekStats {
  start: string; // YYYY-MM-DD, local
  end: string; // last day, YYYY-MM-DD
  complete: number;
  ready: number;
  printed: number;
  quota: number;
  reached: boolean;
  folders: string[];
}

export interface MonthStats {
  month: string; // YYYY-MM
  complete: number;
  ready: number;
  printed: number;
  weeks: WeekStats[];
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Local midnight of the first day of the week that holds `d`. */
export function weekStart(d: Date, startDay: number): Date {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  s.setDate(s.getDate() - ((s.getDay() - startDay + 7) % 7));
  return s;
}

function week(start: Date, rows: ApplicantRow[], quota: number): WeekStats {
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
    reached: complete >= quota,
    folders: rows.map((r) => r.folder),
  };
}

export function applicationStats(rows: ApplicantRow[], opts: { quota: number; startDay: number }, now = new Date()) {
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
  const weeks = [...byWeek.values()].sort((a, b) => b.start.getTime() - a.start.getTime()).map((w) => week(w.start, w.rows, opts.quota));

  const months = new Map<string, MonthStats>();
  for (const w of weeks) {
    const m = w.start.slice(0, 7);
    if (!months.has(m)) months.set(m, { month: m, complete: 0, ready: 0, printed: 0, weeks: [] });
    const ms = months.get(m)!;
    ms.weeks.push(w);
    ms.complete += w.complete;
    ms.ready += w.ready;
    ms.printed += w.printed;
  }
  const current = weeks.find((w) => w.start === ymd(thisStart))!;
  const thisMonth = current.start.slice(0, 7);
  const all = [...months.values()];
  return {
    this_week: { ...current, remaining: Math.max(current.quota - current.complete, 0) },
    // Main page: the current month's weeks. Archive: every earlier month with its weeks.
    current_month: all.find((m) => m.month === thisMonth)!,
    archive: all.filter((m) => m.month < thisMonth),
  };
}
