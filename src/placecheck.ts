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
