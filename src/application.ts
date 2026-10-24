import { z } from 'zod';
import type { IdSeen } from './flow.js';

// Builds the bank-form data for one finished Messenger application: the applicant's own answers, what Claude read
// on the ID photos and found in public info (finalize details), the owner's derived rules, and the owner's
// settings. Never invents personal facts: anything not given is left blank and listed as missing.

export const BANKS = ['metrobank', 'eastwest', 'chinabank'] as const;
export type BankKey = (typeof BANKS)[number];

/** Bank names as extractBanks() writes them (existing cards), per PDF bank. */
const BANK_NAME: Record<BankKey, string> = { metrobank: 'Metrobank', eastwest: 'EastWest', chinabank: 'China Bank' };

const text = (max = 200) => z.string().trim().min(1).max(max);
const addr = z
  .object({
    street: text().optional(),
    barangay: text(100).optional(),
    city: text(100).optional(),
    province: text(100).optional(),
    zip: z.string().regex(/^\d{4}$/).optional(),
    /** False when the city has several zip codes and the barangay did not settle it. */
    zip_sure: z.boolean().optional(),
  })
  .strict();

const nameParts = z.object({ first: text(80), middle: text(80).optional(), last: text(80) }).strict();

// Surname particles: "Dela Cruz", "De los Santos", "San Jose", "Sta. Maria" are one last name.
const PARTICLES = new Set(['de', 'del', 'dela', 'delas', 'delos', 'di', 'da', 'la', 'las', 'los', 'san', 'santa', 'sta', 'sto', 'santo', 'van', 'von', 'y']);

/** Split a full name: last name (with its particles), the word before = middle name, the rest = first name. */
export function splitName(full: string): { first: string; middle?: string; last: string } | undefined {
  const w = full.trim().split(/\s+/).filter(Boolean);
  if (w.length < 2) return undefined;
  let i = w.length - 1;
  while (i - 1 >= 1 && PARTICLES.has(w[i - 1]!.toLowerCase().replace(/\.$/, ''))) i--;
  const last = w.slice(i).join(' ');
  if (i <= 1) return { first: w.slice(0, i).join(' '), last };
  return { first: w.slice(0, i - 1).join(' '), middle: w[i - 1]!, last };
}

/** What Claude read on the ID(s) and looked up. Every field is optional: unknown stays blank and is listed. */
export const detailsSchema = z
  .object({
    first_name: text(80).optional(),
    middle_name: text(80).optional(),
    last_name: text(80).optional(),
    suffix: text(10).optional(),
    birthday: z.iso.date().optional().describe('YYYY-MM-DD as printed on the ID'),
    gender: z.enum(['Male', 'Female']).optional(),
    nationality: text(40).optional(),
    id_number: text(40).optional(),
    tin: z.string().regex(/^\d{3}-?\d{3}-?\d{3}(-?\d{3,5})?$/).optional().describe('Only as printed on a TIN ID or other ID'),
    home: addr.optional().describe("Split from the applicant's answer, or from the ID address if they gave none"),
    home_from_id: z.boolean().optional(),
    company: addr.optional(),
    employer_phone: z.string().max(40).optional(),
    employer_phone_source: z.url().optional().describe('Where the number was found (company site / map listing)'),
    industry: text(80).optional(),
    department: text(80).optional(),
    employment_type: z.enum(['Private Sector', 'Government', 'Self-employed']).optional(),
    /** How to split names that some forms print in First / Middle / Last columns (when the words are ambiguous). */
    mother_name_parts: nameParts.optional(),
    spouse_name_parts: nameParts.optional(),
  })
  .strict();
export type Details = z.infer<typeof detailsSchema>;

export const settingsSchema = z
  .object({
    agent_name: z.string().max(80).default(''),
    agent_code: z.string().max(40).default(''),
    /** Card choice box per bank, e.g. metrobank: "cashbackvisa" (the option name in the PDF). */
    card_choice: z.partialRecord(z.enum(BANKS), z.string().regex(/^[a-z0-9]+$/)).default({}),
    auto_print: z.boolean().default(false),
    /** How answers look on paper: bold, and as big as each box allows up to this size (pt). */
    text_bold: z.boolean().default(true),
    text_max_size: z.number().min(6).max(20).default(14),
    /** One size for every answer (pt); 0 = fit each box instead. Default 11.5 = the "Store Manager" size the owner chose. */
    text_uniform_size: z.number().min(0).max(20).default(11.5),
    /** Print-safe: answers become part of the page (on by default; off only to inspect the boxes). */
    flatten: z.boolean().default(true),
    printer: z.string().max(200).default(''),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;

export interface Lead {
  psid: string;
  completed_at: string;
  banks: string[];
  married: boolean;
  flags?: string[];
  answers: Record<string, string>;
  id_photos?: string[];
  id_review?: IdSeen[];
}

export interface BuiltApplication {
  /** Banks to make a PDF for: the ones the person has no card with. */
  banks: BankKey[];
  /** Values by PDF key (first_name, civil_status, ...). */
  data: Record<string, string>;
  /** Bank-only boxes per bank: stem -> true (tick) or text. */
  bankOnly: Record<BankKey, Record<string, string | true>>;
  /** Shown to the owner; Claude follows up on the ones the applicant can answer. */
  missing: string[];
  /** Values the owner chose as defaults (not from the applicant), shown so nobody mistakes them for answers. */
  defaults: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** "5" -> 5, "<1" -> 0, "6-10" -> 6, "10+" -> 10, "5 years" -> 5. */
export function yearsFrom(answer: string | undefined): number | undefined {
  if (!answer) return undefined;
  if (/^\s*<\s*1/.test(answer)) return 0;
  const n = /\d+/.exec(answer);
  return n ? Number(n[0]) : undefined;
}

export function ageOn(birthday: string, on: Date): number {
  const [y, m, d] = birthday.split('-').map(Number) as [number, number, number];
  let age = on.getFullYear() - y;
  if (on.getMonth() + 1 < m || (on.getMonth() + 1 === m && on.getDate() < d)) age--;
  return age;
}

const CIVIL: Record<string, string> = { single: 'Single', married: 'Married', separated: 'Separated', widowed: 'Widowed', widow: 'Widowed', kasal: 'Married' };

export function buildApplication(lead: Lead, details: Details, now: Date): BuiltApplication {
  const a = lead.answers;
  const missing: string[] = [];
  const defaults: string[] = [];
  const data: Record<string, string> = {};
  const put = (key: string, value: string | number | undefined, label?: string) => {
    if (value === undefined || value === '') {
      if (label) missing.push(label);
      return;
    }
    data[key] = String(value);
  };

  // Names, birthday, sex: from the ID only.
  put('first_name', details.first_name, 'First name (ID)');
  put('middle_name', details.middle_name);
  put('last_name', details.last_name, 'Last name (ID)');
  put('suffix', details.suffix);
  const full = [details.first_name, details.middle_name, details.last_name, details.suffix].filter(Boolean).join(' ');
  put('full_name', full || undefined);
  put('name_on_card', [details.first_name, details.middle_name?.[0] ? `${details.middle_name[0]}.` : '', details.last_name].filter(Boolean).join(' ').toUpperCase() || undefined);
  put('birthday', details.birthday, 'Birthday (ID)');
  put('gender', details.gender, 'Gender (ID)');
  put('nationality', details.nationality ?? undefined, 'Nationality (ID)');
  if (details.nationality && norm(details.nationality) !== 'filipino') put('nationality_other', details.nationality);

  put('birth_town', a.place_of_birth, 'Place of birth');
  const civil = CIVIL[norm(a.civil_status ?? '')];
  put('civil_status', civil, 'Civil status');
  put('email', a.email, 'Email');
  put('mobile', a.mobile, 'Mobile number');
  put('mother_maiden_name', a.mothers_maiden_name, "Mother's maiden name");

  // Home address: their answer split by Claude, or the ID address when they gave none.
  const h = details.home;
  put('street', h?.street, 'Home street');
  put('barangay', h?.barangay, 'Home barangay');
  put('city_province', [h?.city, h?.province].filter(Boolean).join(', ') || undefined, 'Home city/province');
  if (h?.city && !h.province) missing.push('Home province');
  put('zipcode', h?.zip, 'Home zip code');
  if (h?.zip && h.zip_sure === false) missing.push('Home zip code (check: city has several)');
  put('home_address', [h?.street, h?.barangay, h?.city, h?.province].filter(Boolean).join(', ') || undefined);
  if (details.home_from_id) defaults.push('Home address taken from the ID');
  data.permanent_same_as_present = 'yes';
  put('permanent_address', data.home_address);
  put('permanent_zip_code', data.zipcode);

  // Owner rules: ownership and years of stay from age (birthday on the ID).
  const age = details.birthday ? ageOn(details.birthday, now) : undefined;
  if (age !== undefined) {
    const withParents = age <= 25;
    put('home_ownership', withParents ? 'Living with parents' : 'Owned');
    put('years_of_stay', withParents ? age : Math.max(age - 21, 0));
    put('permanent_length_of_stay', data.years_of_stay);
    put('total_years_working', Math.max(age - 21, 0));
    defaults.push('Home ownership, years of stay and total years working computed from age');
  } else {
    missing.push('Home ownership / years of stay / total years working (need birthday from ID)');
  }

  // Work.
  put('employer', a.employer_name, 'Employer');
  put('position', a.position, 'Position');
  put('department', details.department, 'Department');
  put('industry', details.industry, 'Nature of business');
  put('employment_type', details.employment_type, 'Employment type');
  if (details.employment_type) put('employment_status', details.employment_type === 'Self-employed' ? undefined : 'Employed');
  const c = details.company;
  put('company_street', c?.street, 'Office street/building');
  put('company_barangay', c?.barangay, 'Office barangay');
  put('company_city_province', [c?.city, c?.province].filter(Boolean).join(', ') || undefined, 'Office city/province');
  if (c?.city && !c.province) missing.push('Office province');
  if (!c?.zip) missing.push('Office zip code');
  else if (c.zip_sure === false) missing.push('Office zip code (check: city has several)');
  put('company_address', [c?.street, c?.barangay, c?.city, c?.province].filter(Boolean).join(', ') || undefined);
  put('employer_phone', details.employer_phone, 'Office phone (not found)');
  const yrs = yearsFrom(a.years_with_employer);
  put('length_of_service', yrs === undefined ? undefined : `${yrs} ${yrs === 1 ? 'year' : 'years'}`, 'Years with employer');
  if (yrs !== undefined) {
    // Owner rule: year = completion year - years with employer; month = the month they finished applying.
    const done = new Date(lead.completed_at);
    put('date_hired', `${done.getFullYear() - yrs}-${String(done.getMonth() + 1).padStart(2, '0')}-01`);
    defaults.push('Date hired = completion month, year minus years with employer');
  }

  // Not asked on purpose (owner): income and government numbers. Never invented.
  put('gross_income', undefined, 'Gross annual income');
  put('tin_number', details.tin, 'TIN');
  missing.push('SSS/GSIS number');

  // Existing card: issuer from their answer; number is never asked (owner rule: "Refuse to give").
  put('other_card_company', lead.banks[0]);
  data.other_card_number = 'Refuse to give';

  if (lead.married) put('spouse_name', a.spouse_name, 'Spouse name');
  for (const [key, given] of [
    ['mother_maiden_name', details.mother_name_parts],
    ['spouse_name', details.spouse_name_parts],
  ] as const) {
    const parts = given ?? (data[key] ? splitName(data[key]!) : undefined);
    if (!parts || !data[key]) continue;
    put(`${key}_first`, parts.first);
    put(`${key}_middle`, parts.middle);
    put(`${key}_last`, parts.last);
  }
  put('ref_name', a.reference_name);
  put('ref_mobile', a.reference_mobile);

  // Banks: a PDF only where they have no card yet (a pending application still gets one, owner rule).
  const has = new Set(lead.banks.map(norm));
  const banks = BANKS.filter((b) => !has.has(norm(BANK_NAME[b])));

  const bizZip: Record<string, string> = c?.zip ? { business_zip_code: c.zip } : {};
  const idTypes = new Set((lead.id_review ?? []).filter((r) => r.clear).map((r) => r.type));
  const bankOnly: BuiltApplication['bankOnly'] = {
    metrobank: {
      'education__checkbox__college': true,
      'source_of_funds__checkbox__others': true,
      source_of_funds_others: 'Salary',
      'existing_credit_card__checkbox__yes': true,
      'delivery_instruction__checkbox__home': true,
      'soa_delivery__checkbox__personalemail': true,
      ...bizZip,
      ...(idTypes.has('national_id') ? { 'id_type__checkbox__philsys': true } : {}),
      ...(idTypes.has('umid') ? { 'id_type__checkbox__umid': true } : {}),
      ...(idTypes.has('tin') ? { 'id_type__checkbox__tin': true } : {}),
      ...(idTypes.has('sss_old') || idTypes.has('sss_new') ? { 'id_type__checkbox__sss': true } : {}),
      ...(details.id_number ? { government_id_number: details.id_number } : {}),
    },
    eastwest: {
      'education__checkbox__college': true,
      'source_of_funds__checkbox__salarybenefits': true,
      'other_credit_cards__checkbox__yes': true,
      'card_delivery_address__checkbox__presenthomeaddress': true,
      ...bizZip,
    },
    chinabank: {
      'source_of_funds__checkbox__salary': true,
      'card_delivery_address__checkbox__presentaddress': true,
      'soa_delivery__checkbox__personalemailaddress': true,
      'residency__checkbox__resident': true,
      ...(idTypes.has('passport') ? { 'type_of_id__checkbox__passport': true } : {}),
      ...(idTypes.has('prc') ? { 'type_of_id__checkbox__prcid': true } : {}),
      ...(idTypes.has('drivers_license') ? { 'type_of_id__checkbox__driverslicense': true } : {}),
      ...(idTypes.has('voters') ? { 'type_of_id__checkbox__votersid': true } : {}),
      ...(['tin', 'sss_old', 'sss_new'].some((t) => idTypes.has(t as IdSeen['type'])) ? { 'type_of_id__checkbox__tinsssgsisid': true } : {}),
    },
  };
  defaults.push('Education = College (owner default)', 'Source of funds = Salary, card delivery = home, statement = personal email');
  missing.push('Signature (client signs the printed form)');
  // Yes/no declarations only the applicant can answer (relatives at the bank, ties to public officials, existing
  // client of the bank). Never ticked for them.
  missing.push('Bank declarations: relatives at the bank / ties to public officials (applicant answers on the form)');

  return { banks, data, bankOnly, missing, defaults };
}
