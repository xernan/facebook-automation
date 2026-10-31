import { z } from 'zod';
import { parseCivilStatus, type IdSeen } from './flow.js';

// Builds the bank-form data for one finished Messenger application: the applicant's own answers, what Claude read
// on the ID photos and found in public info (finalize details), the owner's derived rules, and the owner's
// settings. Never invents personal facts: anything not given is left blank and listed as missing.

/**
 * Name printed on the card, at most `max` letters (banks charge a penalty when it runs over the boxes).
 * Owner rule: FIRST M. LAST; too long -> drop the middle initial; still too long -> only the first of two given
 * names; then the first initial; the last resort cuts it.
 */
export function cardName(first = '', middle = '', last = '', max = Infinity): string {
  const up = (v: string) => v.replace(/\s+/g, ' ').trim().toUpperCase();
  const f = up(first);
  const l = up(last);
  const mi = up(middle) ? `${up(middle)[0]}.` : '';
  const f1 = f.split(' ')[0] ?? '';
  const tries = [[f, mi, l], [f, l], [f1, l], [f1 ? `${f1[0]}.` : '', l]].map((p) => p.filter(Boolean).join(' '));
  return tries.find((t) => t.length <= max) ?? tries.at(-1)!.slice(0, max);
}

export const BANKS = ['metrobank', 'eastwest', 'chinabank'] as const;
export type BankKey = (typeof BANKS)[number];

/** Bank names as extractBanks() writes them (existing cards), per PDF bank. */
const BANK_NAME: Record<BankKey, string> = { metrobank: 'Metrobank', eastwest: 'EastWest', chinabank: 'China Bank' };

const text = (max = 200) => z.string().trim().min(1).max(max);
const addr = z
  .object({
    /** Unit / floor / building (e.g. "4th Level, Festival Mall"); banks with a separate box print it there. */
    unit: text(120).optional(),
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
    /** Place of birth with the spelling corrected, when you are sure. */
    birth_town: text(120).optional(),
    /** Every place name you corrected, e.g. "Muntinlua -> Muntinlupa". Shown to the owner. */
    spelling_fixes: z.array(text(200)).max(10).optional(),
    /** Anything doubtful about the IDs, for the owner. It never stops the application. */
    id_note: text(200).optional(),
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
    /** Complete applications to reach each week (the owner submits to the banks weekly). */
    weekly_quota: z.number().int().min(1).max(1000).default(10),
    /** What we aim for now while the Page grows (owner: 10 a week in Nov 2026); shown next to the quota. */
    weekly_target: z.number().int().min(1).max(1000).default(10),
    /** First day of the submit week: 0 = Sunday, 1 = Monday ... 6 = Saturday. */
    week_start_day: z.number().int().min(0).max(6).default(1),
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
  /** The Default Form: what the owner sees and can edit in the dashboard. Single source for the PDFs. */
  form: AppForm;
  /** Values by PDF key (first_name, civil_status, ...), built from the form. */
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

// ---- the Default Form ---------------------------------------------------------------------------------------
const s = (max = 300) => z.string().max(max).optional();
const formAddr = z
  .object({ unit: s(120), street: s(), barangay: s(100), city: s(100), province: s(100), zip: s(10), zip_sure: z.boolean().optional() })
  .strict();

/** Same sections as the card app's Default Form (Personal, Address, Employment, References, Other card). */
export const formSchema = z
  .object({
    first_name: s(80),
    middle_name: s(80),
    last_name: s(80),
    suffix: s(10),
    name_on_card: s(40),
    birthday: s(10),
    gender: s(10),
    nationality: s(40),
    birth_town: s(120),
    civil_status: s(20),
    email: s(120),
    mobile: s(30),
    home_phone: s(30),
    mother_maiden_name: s(120),
    mother_name_parts: nameParts.optional(),
    spouse_name: s(120),
    spouse_name_parts: nameParts.optional(),
    home: formAddr.optional(),
    home_ownership: s(30),
    years_of_stay: s(10),
    employer: s(150),
    position: s(100),
    department: s(100),
    industry: s(100),
    employment_type: s(30),
    company: formAddr.optional(),
    employer_phone: s(40),
    length_of_service: s(30),
    /** Months on top of the years (Metrobank's MONTHS box). */
    length_of_service_months: s(10),
    total_years_working: s(10),
    date_hired: s(10),
    gross_income: s(30),
    tin_number: s(20),
    gsis_sss_number: s(20),
    other_card_company: s(60),
    other_card_number: s(30),
    ref_name: s(120),
    ref_relationship: s(60),
    ref_mobile: s(30),
  })
  .strict();
export type AppForm = z.infer<typeof formSchema>;

const has = (v: string | undefined): v is string => v !== undefined && v.trim() !== '';
const join = (...parts: (string | undefined)[]) => parts.filter(has).join(', ');

/** PDF data from the form: the form's own values plus the combined ones some banks print. */
/**
 * Owner default: every bank declaration question is answered NO (existing client of that bank, principal
 * cardholder, related to a bank officer/employee, related to or ties with a government official). Matches the
 * box stem of any form, so a new bank's form is covered when its boxes follow the naming.
 */
export const DECLARE_NO = /^(existing_\w*_client|existing_principal_cardholder|related_to_\w+|relatives_in_\w+|close_ties_\w+)__checkbox__no$/;

/** Owner default: the bank calls the applicant within office hours. */
export const BEST_TIME_TO_CALL = '9AM-5PM';

export function formToData(f: AppForm): Record<string, string> {
  const d: Record<string, string> = {};
  const put = (k: string, v: string | number | undefined) => {
    if (v !== undefined && String(v).trim() !== '') d[k] = String(v).trim();
  };
  for (const k of [
    'first_name', 'middle_name', 'last_name', 'suffix', 'name_on_card', 'birthday', 'gender', 'nationality', 'birth_town',
    'civil_status', 'email', 'mobile', 'home_phone', 'mother_maiden_name', 'home_ownership', 'years_of_stay', 'employer',
    'position', 'department', 'industry', 'employment_type', 'employer_phone', 'length_of_service', 'length_of_service_months', 'total_years_working',
    // Owner rule: SSS/GSIS stays blank on every form, so it is neither filled in nor listed as missing.
    'date_hired', 'gross_income', 'tin_number', 'other_card_company', 'other_card_number', 'ref_name',
    'ref_relationship', 'ref_mobile',
  ] as const) put(k, f[k]);
  put('full_name', [f.first_name, f.middle_name, f.last_name, f.suffix].filter(has).join(' '));
  // Owner default for every form with a "best time to call" box (EastWest today).
  put('best_time_to_call', BEST_TIME_TO_CALL);
  if (f.nationality && norm(f.nationality) !== 'filipino') put('nationality_other', f.nationality);
  const h = f.home ?? {};
  put('street', join(h.unit, h.street));
  put('barangay', h.barangay);
  put('city_province', join(h.city, h.province));
  put('zipcode', h.zip);
  put('home_address', join(h.unit, h.street, h.barangay, h.city, h.province));
  d.permanent_same_as_present = 'yes';
  put('permanent_address', d.home_address);
  put('permanent_zip_code', d.zipcode);
  put('permanent_length_of_stay', d.years_of_stay);
  const c = f.company ?? {};
  // Banks with a unit/floor/building box get it there; the others print it before the street.
  put('business_unit_floor_building', c.unit);
  put('company_street', c.street);
  put('company_barangay', c.barangay);
  put('company_city_province', join(c.city, c.province));
  put('company_address', join(c.unit, c.street, c.barangay, c.city, c.province));
  // China Bank ticks Employed / Self-Employed (Business); a self-employed applicant here owns a business.
  if (f.employment_type) put('employment_status', f.employment_type === 'Self-employed' ? 'Self-employed Business' : 'Employed');
  if (f.civil_status === 'Married') put('spouse_name', f.spouse_name);
  for (const [key, given] of [
    ['mother_maiden_name', f.mother_name_parts],
    ['spouse_name', f.spouse_name_parts],
  ] as const) {
    if (!d[key]) continue;
    const parts = given ?? splitName(d[key]!);
    if (!parts) continue;
    put(`${key}_first`, parts.first);
    put(`${key}_middle`, parts.middle);
    put(`${key}_last`, parts.last);
  }
  return d;
}

/** What is still missing on the form (shown to the owner and followed up), same idea as the card app's checks. */
export function formMissing(f: AppForm): string[] {
  const m: string[] = [];
  const need = (v: string | undefined, label: string) => {
    if (!has(v)) m.push(label);
  };
  need(f.first_name, 'First name (ID)');
  need(f.last_name, 'Last name (ID)');
  need(f.birthday, 'Birthday (ID)');
  need(f.gender, 'Gender (ID)');
  need(f.nationality, 'Nationality (ID)');
  need(f.birth_town, 'Place of birth');
  need(f.civil_status, 'Civil status');
  need(f.email, 'Email');
  need(f.mobile, 'Mobile number');
  need(f.mother_maiden_name, "Mother's maiden name");
  const h = f.home ?? {};
  need(h.street, 'Home street');
  need(h.barangay, 'Home barangay');
  if (!has(h.city) && !has(h.province)) m.push('Home city/province');
  else if (!has(h.province)) m.push('Home province');
  need(h.zip, 'Home zip code');
  if (has(h.zip) && h.zip_sure === false) m.push('Home zip code (check: city has several)');
  if (!has(f.home_ownership) || !has(f.years_of_stay) || !has(f.total_years_working)) {
    m.push('Home ownership / years of stay / total years working (need birthday from ID)');
  }
  need(f.employer, 'Employer');
  need(f.position, 'Position');
  need(f.department, 'Department');
  need(f.industry, 'Nature of business');
  need(f.employment_type, 'Employment type');
  const c = f.company ?? {};
  need(c.street || c.unit, 'Office street/building');
  need(c.barangay, 'Office barangay');
  if (!has(c.city) && !has(c.province)) m.push('Office city/province');
  else if (!has(c.province)) m.push('Office province');
  if (!has(c.zip)) m.push('Office zip code');
  else if (c.zip_sure === false) m.push('Office zip code (check: city has several)');
  need(f.employer_phone, 'Office phone (not found)');
  need(f.length_of_service, 'Years with employer');
  need(f.gross_income, 'Gross annual income');
  need(f.tin_number, 'TIN');
  if (f.civil_status === 'Married') need(f.spouse_name, 'Spouse name');
  // Never on the form: only the applicant can sign or answer these, on paper.
  m.push('Signature (client signs the printed form)');
  return m;
}

/** Bank-only boxes: owner defaults plus the ID types Claude saw. */
/** EastWest "Nature of Work" from the industry words; no box when nothing clearly fits (first match wins). */
const NATURE_OF_WORK: [RegExp, string][] = [
  [/\b(bpo|call ?cent(er|re)|outsourc\w*)\b/i, 'bpo'],
  [/\bpawn ?shop\b/i, 'pawnshop'],
  [/\bremittance\b/i, 'moneytransmittersremittanceagents'],
  [/\bbank(ing)?\b/i, 'banking'],
  [/\binsurance\b/i, 'insurance'],
  [/\b(lending|financ\w*|loans?)\b/i, 'financing'],
  [/\bconstruction\b/i, 'construction'],
  [/\b(manufactur\w*|factory)\b/i, 'manufacturing'],
  [/\b(real ?estate|realty)\b/i, 'realestate'],
  [/\b(transport\w*|logistics?|telecom\w*|shipping|airlines?|courier)\b/i, 'transportationcommunication'],
  [/\b(utilit(y|ies)|electric\w*|water district)\b/i, 'utilities'],
  [/\b(agri\w*|farm\w*|mining|fishing)\b/i, 'agriculturalmining'],
  [/\b(retail|wholesale|store|grocery|supermarket|bakeshop|bakery|trading|sari-?sari)\b/i, 'wholesaleretail'],
  [/\b(clinic|hospital|dental|medical|health\w*|school|education|salon|spa|church)\b/i, 'communitysocialpersonal'],
  [/\b(restaurant|food|hotel|it services|software|consult\w*|services?)\b/i, 'businesscommercialservices'],
];

/**
 * Work boxes that follow the employment type and industry on the form (recomputed when the owner edits the form).
 * Source of funds: owner default Salary; owner rule self-employed = Business (Metrobank's row already has the
 * Self-employed box, so no "Others: Salary" there). EastWest: Position/Rank Owner when self-employed, Nature of Work.
 */
export function workBoxes(bank: BankKey, f: AppForm): Record<string, string | true> {
  const self = f.employment_type === 'Self-employed';
  if (bank === 'metrobank') return self ? {} : { 'source_of_funds__checkbox__others': true, source_of_funds_others: 'Salary' };
  if (bank === 'chinabank') return { [self ? 'source_of_funds__checkbox__business' : 'source_of_funds__checkbox__salary']: true };
  const nature = f.employment_type === 'Government' ? 'government' : NATURE_OF_WORK.find(([re]) => re.test(`${f.industry ?? ''} ${f.employer ?? ''}`))?.[1];
  return {
    [self ? 'source_of_funds__checkbox__businessincome' : 'source_of_funds__checkbox__salarybenefits']: true,
    ...(self ? { 'position_rank__checkbox__owner': true } : {}),
    ...(nature ? { [`nature_of_work__checkbox__${nature}`]: true } : {}),
  };
}
/** Bank-only keys workBoxes() owns. */
export const WORK_BOX = /^(source_of_funds|position_rank|nature_of_work)/;

export function bankOnlyFor(lead: Lead, f: AppForm, idNumber?: string): BuiltApplication['bankOnly'] {
  const bizZip: Record<string, string> = f.company?.zip ? { business_zip_code: f.company.zip } : {};
  const idTypes = new Set((lead.id_review ?? []).filter((r) => r.clear).map((r) => r.type));
  return {
    metrobank: {
      'education__checkbox__college': true,
      ...workBoxes('metrobank', f),
      'existing_credit_card__checkbox__yes': true,
      'delivery_instruction__checkbox__home': true,
      'soa_delivery__checkbox__personalemail': true,
      ...bizZip,
      ...(idTypes.has('national_id') ? { 'id_type__checkbox__philsys': true } : {}),
      ...(idTypes.has('umid') ? { 'id_type__checkbox__umid': true } : {}),
      ...(idTypes.has('tin') ? { 'id_type__checkbox__tin': true } : {}),
      ...(idTypes.has('sss_old') || idTypes.has('sss_new') ? { 'id_type__checkbox__sss': true } : {}),
      ...(idNumber ? { government_id_number: idNumber } : {}),
    },
    eastwest: {
      'education__checkbox__college': true,
      ...workBoxes('eastwest', f),
      'other_credit_cards__checkbox__yes': true,
      'card_delivery_address__checkbox__presenthomeaddress': true,
      ...bizZip,
    },
    chinabank: {
      // Owner default Education = College (a printed box on this form, ticked by pdf.ts).
      'education__checkbox__college': true,
      ...workBoxes('chinabank', f),
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
}

/** The first Default Form from the Messenger answers, the ID and the owner's rules. Never invents personal facts. */
/** A TIN as the person gave it, written XXX-XXX-XXX (or XXX-XXX-XXX-XXX with the branch code); else undefined. */
export function formatTin(raw: string): string | undefined {
  const d = raw.replace(/\D/g, '');
  if (!/^\d{9}(\d{3})?$/.test(d)) return undefined;
  return d.match(/\d{3}/g)!.join('-');
}

const OWNER_TITLE = /\b(owner|co-?owner|proprietor|proprietress|founder|business\s*owner|may-?ari)\b/i;

export function formFromLead(lead: Lead, details: Details, now: Date): { form: AppForm; defaults: string[] } {
  const a = lead.answers;
  const defaults: string[] = [];
  const f: AppForm = {
    first_name: details.first_name,
    middle_name: details.middle_name,
    last_name: details.last_name,
    suffix: details.suffix,
    name_on_card: cardName(details.first_name, details.middle_name, details.last_name) || undefined,
    birthday: details.birthday,
    gender: details.gender,
    nationality: details.nationality,
    birth_town: details.birth_town ?? a.place_of_birth,
    civil_status: parseCivilStatus(a.civil_status ?? ''),
    email: a.email,
    mobile: a.mobile,
    mother_maiden_name: a.mothers_maiden_name,
    mother_name_parts: details.mother_name_parts,
    spouse_name: lead.married ? a.spouse_name : undefined,
    spouse_name_parts: details.spouse_name_parts,
    home: details.home && { unit: details.home.unit, street: details.home.street, barangay: details.home.barangay, city: details.home.city, province: details.home.province, zip: details.home.zip, zip_sure: details.home.zip_sure },
    employer: a.employer_name,
    position: a.position,
    department: details.department ?? a.department,
    industry: details.industry,
    employment_type: details.employment_type,
    company: details.company && { unit: details.company.unit, street: details.company.street, barangay: details.company.barangay, city: details.company.city, province: details.company.province, zip: details.company.zip, zip_sure: details.company.zip_sure },
    employer_phone: details.employer_phone,
    // From the ID first; else what they typed in Messenger (optional question, checked as 9 or 12 digits).
    tin_number: details.tin ? formatTin(details.tin) : a.tin ? formatTin(a.tin) : undefined,
    other_card_company: lead.banks[0],
    // Owner rule: the existing card number is never asked.
    other_card_number: 'Refuse to give',
    ref_name: a.reference_name,
    ref_relationship: a.reference_relationship,
    ref_mobile: a.reference_mobile,
  };
  if (details.home_from_id) defaults.push('Home address taken from the ID');
  for (const fix of details.spelling_fixes ?? []) defaults.push(`Spelling corrected: ${fix}`);
  if (details.id_note) defaults.push(`ID note: ${details.id_note}`);
  // Owner rule: a business owner is self-employed, and a self-employed applicant's position is Owner.
  if (!f.employment_type && f.position && OWNER_TITLE.test(f.position)) f.employment_type = 'Self-employed';
  if (f.employment_type === 'Self-employed' && !f.position) f.position = 'Owner';
  if (f.employment_type === 'Self-employed' && !f.department) {
    f.department = 'Management';
    defaults.push('Department = Management for a business owner (owner default)');
  }

  // Owner rules: ownership, years of stay and total years working from age (birthday on the ID).
  const age = details.birthday ? ageOn(details.birthday, now) : undefined;
  if (age !== undefined) {
    const withParents = age <= 25;
    f.home_ownership = withParents ? 'Living with parents' : 'Owned';
    f.years_of_stay = String(withParents ? age : Math.max(age - 21, 0));
    f.total_years_working = String(Math.max(age - 21, 0));
    defaults.push('Home ownership, years of stay and total years working computed from age');
  }
  const yrs = yearsFrom(a.years_with_employer);
  if (yrs !== undefined) {
    // Owner rule: numbers only in the years box; months = the month they applied (October = 10).
    const done = new Date(lead.completed_at);
    f.length_of_service = String(yrs);
    f.length_of_service_months = String(done.getMonth() + 1);
    // Owner rule: year = completion year - years with employer; month = the month they finished applying.
    f.date_hired = `${done.getFullYear() - yrs}-${String(done.getMonth() + 1).padStart(2, '0')}-01`;
    defaults.push('Date hired = completion month, year minus years with employer', 'Months with employer = month applied (owner default)');
    // Owner rule: total years working is never less than the years with this employer.
    if (f.total_years_working !== undefined && Number(f.total_years_working) < yrs) f.total_years_working = String(yrs);
  }
  defaults.push('Bank declarations (existing client, relatives at the bank, government officials) = NO (owner default)', `Best time to call = ${BEST_TIME_TO_CALL} (owner default)`, 'Education = College (owner default)', 'Source of funds = Salary (Business when self-employed), card delivery = home, statement = personal email');
  return { form: f, defaults };
}

/** Banks to make a PDF for: a PDF only where they have no card yet (a pending application still gets one). */
export function banksFor(lead: Lead): BankKey[] {
  const owned = new Set(lead.banks.map(norm));
  return BANKS.filter((b) => !owned.has(norm(BANK_NAME[b])));
}

export function buildApplication(lead: Lead, details: Details, now: Date): BuiltApplication {
  const { form, defaults } = formFromLead(lead, details, now);
  return {
    banks: banksFor(lead),
    form,
    data: formToData(form),
    bankOnly: bankOnlyFor(lead, form, details.id_number),
    missing: formMissing(form),
    defaults,
  };
}
