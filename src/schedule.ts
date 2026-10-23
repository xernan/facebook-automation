/**
 * Converts an ISO date-time to a unix timestamp for scheduled_publish_time and checks it
 * against the configured window (Meta rejects times that are too soon or too far out).
 */
export function toScheduleTimestamp(iso: string, minMinutes: number, maxDays: number, now = Date.now()): number {
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) {
    throw new Error('scheduled_time needs a timezone, e.g. 2026-11-01T09:00:00+08:00');
  }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error('scheduled_time is not a valid date-time.');
  if (t < now + minMinutes * 60_000) throw new Error(`scheduled_time must be at least ${minMinutes} minutes from now.`);
  if (t > now + maxDays * 86_400_000) throw new Error(`scheduled_time must be within ${maxDays} days.`);
  return Math.floor(t / 1000);
}
