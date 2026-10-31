import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppForm } from './application.js';

// Flags place names that are not in our Philippine address list, so a misspelling is seen before the forms go to the bank.
// It only flags: Claude corrects the sure ones at finalize, and the owner decides the rest in the Default Form.

type City = { barangays?: string[] };
type Address = Record<string, { cities: Record<string, City> }>;

let cached: Address | undefined;
const address = (): Address =>
  (cached ??= JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'ph-address.json'), 'utf8')));

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const cityKey = (s: string) => norm(s.replace(/\bcity\s+of\b|\bcity\b/gi, ''));
const provinceKey = (s: string) => norm(s.replace(/\(ncr\)/gi, ''));
const isMetroManila = (s: string) => ['metromanila', 'ncr', 'nationalcapitalregion'].includes(provinceKey(s));

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** The closest known name, only when it is close enough to be a typo. */
function closest(value: string, names: string[], key: (s: string) => string): string | undefined {
  const v = key(value);
  let best: string | undefined;
  let bestDistance = Math.max(1, Math.floor(v.length / 4)) + 1;
  for (const n of names) {
    const d = distance(v, key(n));
    if (d < bestDistance) {
      best = n;
      bestDistance = d;
    }
  }
  return best;
}

const hint = (name: string | undefined) => (name ? ` (did you mean ${name}?)` : '');

function checkAddress(label: string, a: NonNullable<AppForm['home']> | undefined): string[] {
  const out: string[] = [];
  if (!a) return out;
  const data = address();
  const provinces = Object.keys(data);
  const province = a.province?.trim()
    ? provinces.find((p) => provinceKey(p) === provinceKey(a.province!) || (isMetroManila(a.province!) && provinceKey(p) === 'metromanila'))
    : undefined;
  if (a.province?.trim() && !province) out.push(`Check spelling: ${label} province "${a.province}"${hint(closest(a.province, provinces, provinceKey))}`);

  if (!a.city?.trim()) return out;
  const everywhere = provinces.flatMap((p) => Object.keys(data[p]!.cities).map((c) => ({ p, c })));
  const same = (c: string) => cityKey(c) === cityKey(a.city!);
  const inProvince = province ? Object.keys(data[province]!.cities).find(same) : undefined;
  const elsewhere = everywhere.find((x) => same(x.c));
  if (province && !inProvince && elsewhere) {
    out.push(`Check: ${label} city "${a.city}" is not in ${a.province}`);
    return out;
  }
  if (!inProvince && !elsewhere) {
    const names = province ? Object.keys(data[province]!.cities) : everywhere.map((x) => x.c);
    out.push(`Check spelling: ${label} city "${a.city}"${hint(closest(a.city, names, cityKey))}`);
    return out;
  }

  // The list has barangays for some cities only (Metro Manila); elsewhere they cannot be checked.
  const owner = province ?? elsewhere!.p;
  const barangays = data[owner]!.cities[inProvince ?? elsewhere!.c]!.barangays ?? [];
  if (a.barangay?.trim() && barangays.length > 0 && !barangays.some((b) => norm(b) === norm(a.barangay!))) {
    out.push(`Check spelling: ${label} barangay "${a.barangay}"${hint(closest(a.barangay, barangays, norm))}`);
  }
  return out;
}

function checkBirthplace(place: string | undefined): string[] {
  if (!place?.trim()) return [];
  const data = address();
  const provinces = Object.keys(data);
  const cities = provinces.flatMap((p) => Object.keys(data[p]!.cities));
  const parts = place.split(',').map((s) => s.trim()).filter(Boolean);
  const known = (s: string) => cities.some((c) => cityKey(c) === cityKey(s)) || provinces.some((p) => provinceKey(p) === provinceKey(s));
  if (parts.some(known)) return [];
  // "Malolos Bulacan" has no comma: any known name inside it counts.
  const whole = norm(place);
  if (cities.some((c) => cityKey(c).length >= 4 && whole.includes(cityKey(c)))) return [];
  return [`Check spelling: place of birth "${place}"${hint(closest(parts[0]!, cities, cityKey))}`];
}

/** Place names on the form that are not in our list, worded for the "To check" list. */
export function placeProblems(f: AppForm): string[] {
  return [...checkBirthplace(f.birth_town), ...checkAddress('home', f.home), ...checkAddress('office', f.company)];
}

const STREET_WORDS = /\b(st|street|ave|avenue|road|rd|blvd|boulevard|drive|dr|highway|hwy|lane|ln|ext|extension|purok|sitio|zone)\b|\d/i;
const BUILDING_WORDS = /\b(bldg|building|tower|plaza|mall|center|centre|floor|flr|unit)\b/i;
const BARANGAY_WORD = /\b(brgy|bgy|barangay)\b/i;

/** A city named in the text, with its province, skipping province names that also name a city ("Bulacan" alone). */
function citiesIn(text: string) {
  const data = address();
  const whole = norm(text);
  return Object.keys(data).flatMap((p) =>
    Object.keys(data[p]!.cities)
      .filter((c) => cityKey(c).length >= 4 && whole.includes(cityKey(c)))
      .map((c) => ({ province: p, city: c, rest: whole.replace(cityKey(c), '') })),
  );
}

/** Cities one letter away from a word in the text ("Muntinlua"). Short names are left out: too many near matches. */
function citiesWithTypoIn(text: string) {
  const data = address();
  const words = text.split(/[\s,]+/).map(norm).filter((w) => w.length >= 6);
  return Object.keys(data).flatMap((p) =>
    Object.keys(data[p]!.cities)
      .filter((c) => cityKey(c).length >= 6 && words.some((w) => distance(w, cityKey(c)) === 1))
      .map((c) => ({ province: p, city: c })),
  );
}

const findProvince = (text: string) =>
  Object.keys(address()).find((p) => provinceKey(p) === provinceKey(text) || (isMetroManila(text) && provinceKey(p) === 'metromanila'));

/** The exact name, or the only name one letter away when the name is long enough to tell. */
function matchName(value: string, names: string[], key: (s: string) => string): string | undefined {
  const v = key(value);
  const exact = names.find((n) => key(n) === v);
  if (exact || v.length < 6) return exact;
  const near = names.filter((n) => distance(v, key(n)) === 1);
  return near.length === 1 ? near[0] : undefined;
}

export type PlacePart = 'province' | 'city' | 'barangay';

/**
 * One part of an address, checked against the parts before it: the corrected name, or undefined when it does not
 * belong there. `unchecked`: our list has no barangays for that city, so only Claude can tell.
 */
export function checkPlacePart(part: PlacePart, text: string, province?: string, city?: string): { value: string; unchecked?: boolean } | undefined {
  const place = placeOnly(text);
  if (part === 'province') {
    const found = findProvince(place) ?? matchName(place, Object.keys(address()), provinceKey);
    return found ? { value: found.replace(/\s*\(ncr\)/i, '') } : undefined;
  }
  const inProvince = address()[findProvince(province ?? '') ?? '']?.cities ?? {};
  if (part === 'city') {
    const found = matchName(place, Object.keys(inProvince), cityKey);
    return found ? { value: found } : undefined;
  }
  const barangays = inProvince[city ?? '']?.barangays ?? [];
  if (barangays.length === 0) return { value: place, unchecked: true };
  const found = matchName(place, barangays, norm);
  return found ? { value: found } : undefined;
}

/** "sa Malolos po." -> "Malolos": the place without the words around it. */
const placeOnly = (text: string) => text.trim().replace(/[\s.!]+$/, '').replace(/^(?:taga|sa)\s+/i, '').replace(/\s+(?:po|province|probinsya)$/i, '');

/** The province when the answer names nothing else ("Bulacan", "sa Bulacan po"), with a town in it as an example. */
export function provinceOnly(text: string): { province: string; example: string } | undefined {
  const place = placeOnly(text);
  const data = address();
  const found = Object.keys(data).find((p) => provinceKey(p) === provinceKey(place) || (isMetroManila(place) && provinceKey(p) === 'metromanila'));
  if (!found) return undefined;
  const first = Object.keys(data[found]!.cities)[0] ?? '';
  return { province: found.replace(/\s*\(ncr\)/i, ''), example: first.replace(/\s+city$/i, '') };
}

/** The answer to "where in that province?" as a full place: "Malolos" -> "Malolos, Bulacan". */
export function placeInProvince(province: string, text: string): string {
  if (clearlyComplete('birthplace', text) || norm(text).includes(provinceKey(province))) return text;
  return `${placeOnly(text)}, ${province}`;
}

/** True only when the answer is clearly complete, so the bot can move on at once. Anything else goes to Claude. */
export function clearlyComplete(kind: 'birthplace' | 'home_address' | 'office_address', text: string): boolean {
  const found = citiesIn(text);
  const hasProvince = (x: { province: string; rest: string }) => x.rest.includes(provinceKey(x.province));
  if (kind === 'birthplace') {
    const isProvinceName = Object.keys(address()).some((p) => provinceKey(p) === norm(text));
    if (isProvinceName) return false;
    return found.some((x) => provinceKey(x.province) === 'metromanila' || hasProvince(x));
  }
  const street = STREET_WORDS.test(text) || (kind === 'office_address' && BUILDING_WORDS.test(text));
  if (!street) return false;
  // A misspelled city is still a complete address: the spelling is corrected or flagged at finalize.
  return [...found, ...citiesWithTypoIn(text)].some((x) => {
    const barangays = address()[x.province]!.cities[x.city]!.barangays ?? [];
    return BARANGAY_WORD.test(text) || barangays.some((b) => norm(text).includes(norm(b)));
  });
}
