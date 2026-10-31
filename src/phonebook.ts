import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { replaceFile } from './files.js';

// Our own directory of real office landlines, per company and branch city (this PC only:
// <flowDir>/company-phones.json). A number goes in only with where it came from: a public page found online,
// or typed by the owner. It is never made up; a company/city that is not in it stays blank.

const entrySchema = z
  .object({
    company: z.string().trim().min(1).max(120),
    city: z.string().trim().max(100),
    phone: z.string().trim().min(5).max(40),
    source: z.string().trim().min(1).max(300),
    saved_at: z.string(),
  })
  .strict();
export type PhoneEntry = z.infer<typeof entrySchema>;
const bookSchema = z.object({ entries: z.array(entrySchema) }).strict();

export const OWNER_SOURCE = 'Entered by owner';

const SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|philippines|phils?|ph|opc)\b/g;

/** "Jollibee Foods Corp." -> "jollibee foods"; used to match the same company written differently. */
export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const cityKey = (c: string) => companyKey(c).replace(/\bcity( of)?\b/g, '').replace(/\s+/g, ' ').trim();

// First words too common to name a company by themselves ("San Miguel" is not "San Roque").
const GENERIC = new Set(['san', 'sta', 'sto', 'santa', 'santo', 'st', 'the', 'bank', 'first', 'philippine', 'national', 'global', 'united', 'asian', 'asia', 'metro', 'new', 'golden', 'super', 'mega', 'pacific', 'royal', 'grand', 'city', 'star']);

/**
 * Same company: one name's words start the other's ("jollibee" ~ "jollibee alabang"), or the same distinctive
 * first word ("jollibee foods" ~ "jollibee alabang"). The branch city must match too, so this stays narrow.
 */
function sameCompany(a: string, b: string): boolean {
  const x = companyKey(a).split(' ');
  const y = companyKey(b).split(' ');
  if (!x[0] || !y[0]) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.every((w, i) => long[i] === w)) return true;
  return x[0] === y[0] && x[0].length >= 4 && !GENERIC.has(x[0]);
}

const file = (flowDir: string) => path.join(flowDir, 'company-phones.json');

export async function loadPhonebook(flowDir: string): Promise<PhoneEntry[]> {
  try {
    return bookSchema.parse(JSON.parse(await fs.readFile(file(flowDir), 'utf8'))).entries;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw new Error('company-phones.json is invalid; fix or delete it.');
  }
}

async function save(flowDir: string, entries: PhoneEntry[]): Promise<void> {
  await fs.mkdir(flowDir, { recursive: true });
  const tmp = `${file(flowDir)}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ entries }, null, 2), 'utf8');
  await replaceFile(tmp, file(flowDir));
}

/**
 * The saved number for this company in this city. Branches have their own numbers and area codes, so a
 * number from another city is never used.
 */
export async function lookupPhone(flowDir: string, company: string | undefined, city: string | undefined): Promise<PhoneEntry | undefined> {
  if (!company?.trim() || !city?.trim()) return undefined;
  const c = cityKey(city);
  return (await loadPhonebook(flowDir)).find((e) => sameCompany(e.company, company) && cityKey(e.city) === c);
}

/** Saves (or replaces) the number for a company + city. Needs a source. */
export async function rememberPhone(flowDir: string, e: Omit<PhoneEntry, 'saved_at'>, now = new Date()): Promise<void> {
  const entry = entrySchema.parse({ ...e, saved_at: now.toISOString() });
  if (!entry.city) return;
  const entries = (await loadPhonebook(flowDir)).filter((x) => !(sameCompany(x.company, entry.company) && cityKey(x.city) === cityKey(entry.city)));
  await save(flowDir, [...entries, entry].sort((a, b) => a.company.localeCompare(b.company) || a.city.localeCompare(b.city)));
}

export async function forgetPhone(flowDir: string, company: string, city: string): Promise<boolean> {
  const all = await loadPhonebook(flowDir);
  const left = all.filter((x) => !(x.company === company && x.city === city));
  if (left.length === all.length) return false;
  await save(flowDir, left);
  return true;
}
