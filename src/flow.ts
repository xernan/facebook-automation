import { z } from 'zod';
import { extractBanks, extractEmails, extractPhones } from './leads.js';
import { checkPlacePart, cityFromAnswer, clearlyComplete, placeInProvince, provinceOnly } from './placecheck.js';

// Messenger application flow: a fixed script the Page follows with each person, one state per person.
// The qualifier rules (no card -> reject with cooldown, all excluded banks -> stop) are decided here in
// code, never by the AI, so they are the same every time. Texts live in the owner's flow file
// (FB_FLOW_FILE, git-ignored); flow.example.json shows the shape.

const msg = z.string().trim().min(1).max(2000);

export const ID_TYPES = [
  'drivers_license',
  'passport',
  'umid',
  'postal',
  'voters',
  'sss_old',
  'prc',
  'sss_new',
  'national_id',
  'philhealth',
  'tin',
  'other',
] as const;
const idType = z.enum(ID_TYPES);
/** Messenger quick-reply buttons: at most 13, each title at most 20 characters. */
const choices = z.array(z.string().trim().min(1).max(20)).min(1).max(13).optional();

export const flowSchema = z
  .object({
    greeting: msg,
    consent: z.object({ prompt: msg, decline_reply: msg, choices }).strict(),
    carded: z.object({ prompt: msg, reject_reply: msg, choices }).strict(),
    banks: z
      .object({
        prompt: msg,
        unknown_reply: msg,
        exclude_if_all: z.array(z.string().min(1)).min(1),
        excluded_reply: msg,
        /** Bank buttons, tapped one at a time. At most 12: Messenger shows 13 and one is the done button. */
        choices: z.array(z.string().trim().min(1).max(20)).min(1).max(12).optional(),
        more_prompt: msg.optional(),
        done_choice: z.string().trim().min(1).max(20).default('Tapos na'),
        /** Shown before any pick: their cards are from other banks, so the flow moves on with none listed. */
        none_choice: z.string().trim().min(1).max(20).default('Wala dito'),
      })
      .strict(),
    steps: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z_]+$/),
            prompt: msg,
            only_if_married: z.boolean().optional(),
            /** This answer is the civil status: "married"/"kasal" turns on the only_if_married questions. */
            sets_married: z.boolean().optional(),
            /** Check the answer's shape; on a bad answer send invalid_reply and ask again. */
            validate: z.enum(['mobile', 'email', 'tin', 'sss_gsis', 'date', 'number', 'yes_no', 'civil_status']).optional(),
            /** A clear "yes" adds this flag to the lead (e.g. pending_application), so the client sees it. */
            flag_if_yes: z.string().regex(/^[a-z_]+$/).optional(),
            /** Asked only when the lead has this flag; the answer is added to the flag ("pending_application: BPI"). */
            detail_of_flag: z.string().regex(/^[a-z_]+$/).optional(),
            invalid_reply: msg.optional(),
            /** Fixed buttons shown with the question. Typing an answer still works. */
            choices,
            /** What Claude must find in the answer before it counts (the script never accepts it alone). */
            check: msg.optional(),
            /** The code accepts a clearly complete answer of this kind at once; anything else still goes to Claude. */
            auto_accept: z.enum(['birthplace', 'home_address', 'office_address']).optional(),
            /** Sent at once when the answer is only a province; {province} and {example} are filled in. The next answer is joined to that province. */
            province_only_reply: msg.optional(),
            /** Messenger button that offers the email or phone on their Facebook profile. Hidden when the profile has none. */
            autofill: z.enum(['user_email', 'user_phone_number']).optional(),
            /**
             * Steps sharing a group are optional together: a skip word ("skip", "laktaw", "wala") on the
             * first one skips the whole group.
             */
            optional_group: z.string().regex(/^[a-z_]+$/).optional(),
            /** Claude may attach suggestions found in public info (e.g. a branch address) to this question. */
            suggest: z.boolean().optional(),
            /** Asked only when Claude found suggestions; otherwise, or on the "other" button, the flow moves to the next step. */
            suggest_only: z.boolean().optional(),
            /** One part of the answer to this step, skipped when that answer is known. Parts are asked from largest place to smallest, and joined when the last one is answered. */
            part_of: z.string().regex(/^[a-z_]+$/).optional(),
            /** Check this part against the parts before it; on a bad answer send invalid_reply and ask again. */
            place_part: z.enum(['province', 'city', 'barangay']).optional(),
          })
          .refine((s) => !s.validate || s.invalid_reply, { message: 'invalid_reply is required with validate' })
          .refine((s) => !s.place_part || (s.invalid_reply && s.part_of), { message: 'place_part needs invalid_reply and part_of' })
          .refine((s) => !s.suggest_only || s.suggest, { message: 'suggest_only needs suggest' })
          .refine((s) => !s.flag_if_yes || s.validate === 'yes_no', { message: 'flag_if_yes needs validate "yes_no"' })
          .strict(),
      )
      .min(1),
    id_photo: z
      .object({
        prompt: msg,
        need_image_reply: msg,
        /** Sent as soon as a photo is saved, while Claude reads it. */
        received_reply: msg.optional(),
        /** Sent after Claude reviews the photos and the ID set is not enough yet. */
        unclear_reply: msg,
        need_back_reply: msg,
        need_second_reply: msg,
        need_signature_reply: msg,
        need_primary_reply: msg,
      })
      .strict(),
    /**
     * Which IDs are enough (owner rules). primary: enough alone. pair: needs another ID too (and both sides
     * when both_sides; the other ID must show a signature when second_needs_signature). secondary: only
     * counts as the second ID.
     */
    id_rules: z
      .object({
        primary: z.array(idType).min(1),
        pair: z.partialRecord(idType, z.object({ both_sides: z.boolean(), second_needs_signature: z.boolean() }).strict()),
        secondary: z.array(idType),
      })
      .strict(),
    done_reply: msg,
    /** One reminder to someone who stopped mid-application (the question they are on follows it). */
    nudge: msg.default('Hi! Tuloy pa ba natin ang application mo? 🙂 Ito ang susunod na tanong:'),
    yes_no_reply: msg,
    /** Shown with suggestions: the button that means "none of these, I will type it". */
    other_choice: z.string().trim().min(1).max(20).default('Iba'),
    other_reply: msg.default('Sige, pakitype na lang.'),
    skip_choice: z.string().trim().min(1).max(20).default('Skip'),
  })
  .strict();

export type Flow = z.infer<typeof flowSchema>;
type Step = Flow['steps'][number];

export type Stage =
  | 'new'
  | 'consent'
  | 'carded'
  | 'banks'
  | 'steps'
  | 'id_photo'
  | 'done'
  | 'declined'
  | 'rejected'
  | 'excluded';

export interface Person {
  stage: Stage;
  step: number;
  answers: Record<string, string>;
  banks: string[];
  married: boolean;
  /** Things the client should check, e.g. pending_application. */
  flags?: string[];
  consent_at?: string;
  cooldown_until?: string;
  id_image_url?: string;
  /** Saved ID photos (paths inside FB_FLOW_DIR), in the order received. */
  id_files?: string[];
  /** Claude's latest reading of each ID photo (same order as id_files). */
  id_review?: IdSeen[];
  /** Suggestions shown with the current question; a reply "1".."n" picks one. */
  suggestions?: string[];
  /** The province they answered with; the next answer says where in it (see province_only_reply). */
  place_province?: string;
  updated_at: string;
  /** When they first wrote (for the funnel stats). Older records may not have it. */
  started_at?: string;
  /** The saved lead (lead-<psid>-<time>.json) once the application is complete. */
  lead_file?: string;
  /** When fb_lead_finalize made the PDFs; until then the watcher keeps asking Claude to finalize. */
  finalized_at?: string;
  /** Claude would not finalize: the IDs do not look right (owner checks it in the dashboard). Stops the retries. */
  hold?: { at: string; reason: string };
  /** When we sent the one reminder for the question they stopped at (see sendNudges). */
  nudged_at?: string;
  /** A reply saved but not sent yet (see fb_flow_answer). */
  outbox?: { text: string; for_messages: string[]; choices?: string[] };
}

/** What Claude read on one ID photo. */
export interface IdSeen {
  type: (typeof ID_TYPES)[number];
  side: 'front' | 'back' | 'both';
  clear: boolean;
  has_signature: boolean;
  name?: string;
  birthday?: string;
  sex?: string;
}

export interface Incoming {
  text: string;
  image_url?: string;
}

export interface Advance {
  person: Person;
  /** Text to send now. Undefined = the script has nothing to say (Claude answers freely). */
  reply?: string;
  /** Quick-reply buttons to send with the reply. */
  choices?: string[];
  /** True when this message completed the application (save the lead). */
  completed?: boolean;
  /** An ID photo arrived: save it, then Claude reviews it (fb_flow_id_review). */
  received_id_image?: string;
}

export const newPerson = (now: Date): Person => ({
  stage: 'new',
  step: 0,
  answers: {},
  banks: [],
  married: false,
  updated_at: now.toISOString(),
  started_at: now.toISOString(),
});

// Whole words only. The old bot matched substrings, so "Oo, meron ako noon" read as "no".
const YES = new Set(['yes', 'y', 'yep', 'yup', 'oo', 'opo', 'oho', 'meron', 'mayroon', 'may', 'carded', 'sige', 'ok', 'okay', 'go', 'agree', 'pumapayag', 'payag']);
const NO = new Set(['no', 'n', 'nope', 'hindi', 'di', 'wala', 'ayoko', 'ayaw', 'huwag', 'wag']);
const SKIP = new Set(['skip', 'laktaw', 'wala', 'next', 'pass']);

const words = (text: string) => text.toLowerCase().normalize('NFKD').match(/[a-z]+/g) ?? [];

/** "yes", "no", or undefined when unclear (both kinds of words, or neither). Unclear is asked again, never rejected. */
export function parseYesNo(text: string): 'yes' | 'no' | undefined {
  const w = words(text);
  const yes = w.some((x) => YES.has(x));
  const no = w.some((x) => NO.has(x));
  if (yes === no) return undefined;
  return yes ? 'yes' : 'no';
}

/** A short reply that only says "skip" (one or two words, e.g. "skip", "wala po"). */
const isSkip = (text: string) => {
  const w = words(text);
  return w.length > 0 && w.length <= 2 && SKIP.has(w[0]!);
};

const MARRIED = /\b(married|kasal|may\s+asawa)\b/i;
const isGreeting = (text: string) =>
  /^(hi+|hello+|helo|hey|good\s*(morning|afternoon|evening|eve|day)|gud\s*(morning|am|pm|eve)|kumusta|musta)(\s+(po|sir|ma'?am))?[\s.!]*$/i.test(text);

const CIVIL: Record<string, string> = {
  single: 'Single', binata: 'Single', dalaga: 'Single',
  married: 'Married', kasal: 'Married', mayasawa: 'Married',
  separated: 'Separated', hiwalay: 'Separated',
  widowed: 'Widowed', widow: 'Widowed', widower: 'Widowed', biyuda: 'Widowed', biyudo: 'Widowed', balo: 'Widowed',
};

/** The civil status on the forms ("kasal po" -> "Married"), or undefined when the answer is not one. */
export function parseCivilStatus(text: string): string | undefined {
  return CIVIL[text.toLowerCase().replace(/\bpo\b/g, '').replace(/[^a-z]/g, '')];
}

const digits = (t: string) => t.replace(/\D/g, '');

/** Shape checks for one-question answers. Lenient on spacing and dashes, strict on length. */
export function validAnswer(kind: NonNullable<Step['validate']>, text: string): boolean {
  switch (kind) {
    case 'mobile':
      return extractPhones(text).length === 1;
    case 'email':
      return extractEmails(text).length === 1;
    case 'tin': // 9 digits, or 12 with branch code
      return /^\d{9}(\d{3})?$/.test(digits(text));
    case 'sss_gsis': // SSS 10 digits, GSIS 11
      return /^\d{10,11}$/.test(digits(text));
    case 'date': // mm/dd/yy or mm/dd/yyyy
      return /^(0?[1-9]|1[0-2])[/-](0?[1-9]|[12]\d|3[01])[/-](\d{2}|\d{4})$/.test(text.trim());
    case 'number':
      return /\d/.test(text);
    case 'yes_no':
      return parseYesNo(text) !== undefined;
    case 'civil_status':
      return parseCivilStatus(text) !== undefined;
  }
}

/** Clean suggestions from Claude: trimmed, unique, at most 5, each one line. */
export function cleanSuggestions(list: string[] | undefined): string[] {
  const out = [...new Set((list ?? []).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 0 && s.length <= 200))];
  return out.slice(0, 5);
}

const AUTOFILL_PREFIX = 'autofill:';

/** One button for the Send API: plain text, or Messenger's profile email or phone button. */
export function quickReply(choice: string) {
  if (choice.startsWith(AUTOFILL_PREFIX)) return { content_type: choice.slice(AUTOFILL_PREFIX.length) };
  return { content_type: 'text', title: choice, payload: choice };
}

interface Question {
  reply: string;
  choices?: string[];
}

/** The question for `step`, with its buttons, or with numbered suggestions when there are any. */
function question(flow: Flow, p: Person, step: Step, suggestions: string[]): Question {
  delete p.suggestions;
  const plain = step.optional_group && isFirstOfGroup(flow, p.step) ? [...(step.choices ?? []), flow.skip_choice] : step.choices;
  const base = step.autofill ? [`${AUTOFILL_PREFIX}${step.autofill}`, ...(plain ?? [])] : plain;
  if (step.suggest && suggestions.length > 0) {
    p.suggestions = suggestions;
    // Short ones fit on a button (Messenger limit: 20 characters), so the words themselves are tapped.
    if (suggestions.every((s) => s.length <= 20)) return { reply: step.prompt, choices: [...suggestions, flow.other_choice] };
    const list = suggestions.map((s, i) => `${i + 1}) ${s}`).join('\n');
    return { reply: `${step.prompt}\n\n${list}`, choices: [...suggestions.map((_, i) => String(i + 1)), flow.other_choice] };
  }
  return { reply: step.prompt, choices: base };
}

function isFirstOfGroup(flow: Flow, i: number): boolean {
  const g = flow.steps[i]?.optional_group;
  return !!g && flow.steps[i - 1]?.optional_group !== g;
}

/** Bank buttons not picked yet, plus "done" after a pick or "none of these" before one. */
function bankButtons(flow: Flow, p: Person): string[] | undefined {
  if (!flow.banks.choices) return undefined;
  const left = flow.banks.choices.filter((c) => !extractBanks(c).some((b) => p.banks.includes(b)));
  return [...left, p.banks.length > 0 ? flow.banks.done_choice : flow.banks.none_choice];
}

/** The matching button, or a plain "no more" such as "wala na". */
function banksDone(flow: Flow, p: Person, text: string): boolean {
  const button = p.banks.length > 0 ? flow.banks.done_choice : flow.banks.none_choice;
  return text.toLowerCase() === button.toLowerCase() || parseYesNo(text) === 'no';
}

/** This step's address part checked against the parts already answered. */
function checkPart(flow: Flow, p: Person, step: Step, text: string) {
  const earlier = (part: string) => p.answers[flow.steps.find((s) => s.part_of === step.part_of && s.place_part === part)?.key ?? ''];
  return checkPlacePart(step.place_part!, text, earlier('province'), earlier('city'));
}

/** Moves `p` to the next question that applies from step `from` and returns it (or the ID photo prompt). */
function goToStep(flow: Flow, p: Person, from: number, suggestions: string[] = []): Question {
  let i = from;
  const skip = (s: Step) =>
    (s.only_if_married && !p.married) ||
    (s.detail_of_flag && !p.flags?.includes(s.detail_of_flag)) ||
    (s.suggest_only && suggestions.length === 0) ||
    (s.part_of && (p.answers[s.part_of] || p.answers[s.key]));
  while (flow.steps[i] && skip(flow.steps[i]!)) i++;
  const step = flow.steps[i];
  if (step) {
    p.stage = 'steps';
    p.step = i;
    return question(flow, p, step, suggestions);
  }
  delete p.suggestions;
  p.stage = 'id_photo';
  return { reply: flow.id_photo.prompt };
}

/**
 * Feed one message (or several joined) from the person into the script. Pure: no I/O.
 * `suggestions` are for the NEXT question, used only if that question has suggest=true.
 */
export function advance(flow: Flow, prev: Person, input: Incoming, now: Date, cooldownDays: number, suggestions: string[] = []): Advance {
  const p: Person = {
    ...prev,
    answers: { ...prev.answers },
    banks: [...prev.banks],
    flags: prev.flags && [...prev.flags],
    suggestions: prev.suggestions && [...prev.suggestions],
    updated_at: now.toISOString(),
  };
  const text = input.text.trim();
  const ask = (reply: string, choices?: string[]): Advance => ({ person: p, reply, choices });
  const askQ = (q: Question): Advance => ({ person: p, reply: q.reply, choices: q.choices });

  switch (p.stage) {
    case 'rejected':
      if (p.cooldown_until && now < new Date(p.cooldown_until)) return { person: prev };
      // Cooldown over: start again.
      return advance(flow, newPerson(now), input, now, cooldownDays, suggestions);

    case 'new':
    case 'declined':
      p.stage = 'consent';
      return ask(`${flow.greeting}\n\n${flow.consent.prompt}`, flow.consent.choices);

    case 'consent': {
      const a = parseYesNo(text);
      if (!a) return ask(`${flow.yes_no_reply}\n\n${flow.consent.prompt}`, flow.consent.choices);
      if (a === 'no') {
        p.stage = 'declined';
        return ask(flow.consent.decline_reply);
      }
      p.stage = 'carded';
      p.consent_at = now.toISOString();
      return ask(flow.carded.prompt, flow.carded.choices);
    }

    case 'carded': {
      const a = parseYesNo(text);
      if (!a) return ask(`${flow.yes_no_reply}\n\n${flow.carded.prompt}`, flow.carded.choices);
      if (a === 'no') {
        p.stage = 'rejected';
        p.cooldown_until = new Date(now.getTime() + cooldownDays * 86_400_000).toISOString();
        return ask(flow.carded.reject_reply);
      }
      p.stage = 'banks';
      return ask(flow.banks.prompt, bankButtons(flow, p));
    }

    case 'banks': {
      const found = extractBanks(text);
      let banks = found;
      if (flow.banks.choices) {
        // Tapped one at a time: a person can hold several cards, and every one counts for the exclusion and the PDFs.
        if (found.length > 0) {
          p.banks = [...new Set([...p.banks, ...found])];
          return ask(flow.banks.more_prompt ?? flow.banks.prompt, bankButtons(flow, p));
        }
        if (!banksDone(flow, p, text)) return ask(flow.banks.unknown_reply, bankButtons(flow, p));
        banks = p.banks;
      } else if (found.length === 0) return ask(flow.banks.unknown_reply);
      p.banks = banks;
      // Owner rule: go on while any of our banks is left. A bank added to the buttons counts here too.
      const exclude = [...flow.banks.exclude_if_all, ...(flow.banks.choices ?? [])].map((b) => b.toLowerCase());
      if (exclude.every((b) => banks.some((x) => x.toLowerCase() === b))) {
        p.stage = 'excluded';
        return ask(flow.banks.excluded_reply);
      }
      return askQ(goToStep(flow, p, 0, suggestions));
    }

    case 'steps': {
      const step = flow.steps[p.step];
      if (!step) return askQ(goToStep(flow, p, p.step, suggestions)); // flow file changed under this person
      if (!text || isGreeting(text)) return askQ(question(flow, p, step, p.suggestions ?? []));

      let answer = text;
      if (p.suggestions?.length) {
        const shown = p.suggestions;
        if (answer.toLowerCase() === flow.other_choice.toLowerCase()) {
          delete p.suggestions;
          if (step.suggest_only) return askQ(goToStep(flow, p, p.step + 1));
          return ask(flow.other_reply);
        }
        // A tapped number picks that suggestion; anything else is the person's own typed answer.
        const n = /^\d+$/.test(answer) ? Number(answer) : 0;
        if (n >= 1 && n <= shown.length) answer = shown[n - 1]!;
      }

      if (step.optional_group && isFirstOfGroup(flow, p.step) && isSkip(answer)) {
        let i = p.step;
        while (flow.steps[i]?.optional_group === step.optional_group) i++;
        return askQ(goToStep(flow, p, i, suggestions));
      }
      if (step.validate && !validAnswer(step.validate, answer)) {
        const q = question(flow, p, step, p.suggestions ?? []);
        return ask(`${step.invalid_reply}\n\n${q.reply}`, q.choices);
      }
      if (step.place_part) {
        const part = checkPart(flow, p, step, answer);
        const city = !part && step.place_part === 'province' ? cityFromAnswer(answer) : undefined;
        const cityStep = flow.steps.find((s) => s.part_of === step.part_of && s.place_part === 'city');
        if (city && cityStep) {
          // They gave the city, which also tells the province: no need to ask for it.
          p.answers[step.key] = city.province;
          p.answers[cityStep.key] = city.city;
          return askQ(goToStep(flow, p, p.step + 1, suggestions));
        }
        if (!part) return ask(`${step.invalid_reply}\n\n${step.prompt}`);
        answer = part.value;
      }
      if (step.validate === 'civil_status') answer = parseCivilStatus(answer)!;
      if (step.province_only_reply) {
        const only = provinceOnly(answer);
        if (only) {
          p.place_province = only.province;
          return ask(step.province_only_reply.replaceAll('{province}', only.province).replaceAll('{example}', only.example));
        }
        if (p.place_province) answer = placeInProvince(p.place_province, answer);
        delete p.place_province;
      }
      p.answers[step.key] = answer;
      if (step.part_of && flow.steps[p.step + 1]?.part_of !== step.part_of) {
        const parts = flow.steps.filter((s) => s.part_of === step.part_of).map((s) => p.answers[s.key]).filter(Boolean);
        p.answers[step.part_of] = parts.reverse().join(', ');
      }
      if (step.sets_married) p.married = MARRIED.test(answer);
      if (step.flag_if_yes && parseYesNo(answer) === 'yes') p.flags = [...new Set([...(p.flags ?? []), step.flag_if_yes])];
      if (step.detail_of_flag) p.flags = (p.flags ?? []).map((f) => (f === step.detail_of_flag ? `${f}: ${answer}` : f));
      return askQ(goToStep(flow, p, p.step + 1, suggestions));
    }

    case 'id_photo':
      // The code never decides an ID is fine on its own: Claude reads each photo, then idVerdict() decides.
      if (!input.image_url) return ask(flow.id_photo.need_image_reply);
      return { person: p, received_id_image: input.image_url };

    case 'done':
    case 'excluded':
      return { person: prev };
  }
}

// Words that make a message a question for Claude, even without a "?".
const QUESTION_WORDS = new Set(['magkano', 'paano', 'pano', 'bakit', 'kailan', 'ano', 'anong', 'saan', 'sino', 'pwede', 'puwede', 'gaano', 'ilan', 'how', 'what', 'why', 'when', 'where', 'who', 'can', 'fee', 'bayad', 'scam', 'legit', 'requirements']);
const GREETING_WORDS = new Set(['hi', 'hello', 'helo', 'hey', 'good', 'gud', 'morning', 'afternoon', 'evening', 'eve', 'po', 'sir', 'maam', 'ma', 'am', 'interested', 'apply', 'credit', 'card', 'cards', 'info', 'pm', 'pa', 'yes', 'oo', 'kumusta', 'musta']);

/**
 * True when the script alone can answer these messages right away, without waking Claude: a greeting to start,
 * a clear yes/no, bank names, a tapped button, a valid number/email/TIN, or a plain answer to a free-text question.
 * Anything that may be a question, an image, or a reply at the ID step goes to Claude.
 */
export function scriptCanAnswer(flow: Flow, p: Person, input: Incoming): boolean {
  // An ID photo is downloaded to our folder at once (nothing is sent); Claude reads it right after.
  if (input.image_url) return p.stage === 'id_photo';
  const text = input.text.trim();
  if (!text || text.includes('?')) return false;
  const w = words(text);
  if (w.some((x) => QUESTION_WORDS.has(x))) return false;
  // A "hi" in the middle gets the current question again.
  if (isGreeting(text) && ['consent', 'carded', 'banks', 'steps', 'id_photo'].includes(p.stage)) return true;
  switch (p.stage) {
    case 'new':
      return w.length > 0 && w.length <= 5 && w.every((x) => GREETING_WORDS.has(x));
    case 'consent':
    case 'carded':
      return !!parseYesNo(text);
    case 'banks':
      return extractBanks(text).length > 0 || (!!flow.banks.choices && banksDone(flow, p, text));
    case 'steps': {
      const step = flow.steps[p.step];
      if (!step) return false;
      // A picked suggestion or the "other" button needs no check: these are checked before they are shown.
      if (p.suggestions?.length && (/^\d+$/.test(text) || [...p.suggestions, flow.other_choice].some((c) => c.toLowerCase() === text.toLowerCase()))) return true;
      if (step.place_part) {
        const part = checkPart(flow, p, step, text);
        return !part || !part.unchecked; // a wrong one gets the same reply from the script; one our list cannot tell goes to Claude
      }
      if (step.province_only_reply && (p.place_province || provinceOnly(text))) return w.length <= 25;
      if (step.check) return !!step.auto_accept && clearlyComplete(step.auto_accept, text);
      const tapped =[...(step.choices ?? []), ...(step.optional_group ? [flow.skip_choice] : []), ...(p.suggestions?.length ? [flow.other_choice] : [])];
      if (tapped.some((c) => c.toLowerCase() === text.toLowerCase())) return true;
      if (p.suggestions?.length && /^\d+$/.test(text)) return true;
      // A wrong civil status gets the same reply from the script, so there is no need to wait for Claude.
      if (step.validate === 'civil_status') return true;
      if (step.validate) return validAnswer(step.validate, text);
      // Free text (names, places, addresses): short plain answers only.
      return w.length <= 25;
    }
    default:
      return false;
  }
}

/** The step a person would be asked next if `input` answered the current one (for Claude to prepare suggestions). */
export function nextStepIf(flow: Flow, p: Person, input: Incoming, now: Date, cooldownDays: number): Step | undefined {
  // As if suggestions exist: a suggest_only step is the next one until Claude has looked.
  const r = advance(flow, p, input, now, cooldownDays, ['?']);
  if (r.person.stage !== 'steps' || (p.stage === 'steps' && r.person.step === p.step)) return undefined;
  return flow.steps[r.person.step];
}

/** The question the person is answering now, for Claude to re-ask after an off-script reply. */
export function currentPrompt(flow: Flow, p: Person): string | undefined {
  switch (p.stage) {
    case 'consent':
      return flow.consent.prompt;
    case 'carded':
      return flow.carded.prompt;
    case 'banks':
      return flow.banks.prompt;
    case 'steps':
      return flow.steps[p.step]?.prompt;
    case 'id_photo':
      return flow.id_photo.prompt;
    default:
      return undefined;
  }
}

/** The question they are on with its buttons, as it was first sent (used to pick a chat up again). No side effects. */
export function currentQuestion(flow: Flow, p: Person): Question | undefined {
  const reply = currentPrompt(flow, p);
  if (!reply) return undefined;
  if (p.stage === 'consent') return { reply, choices: flow.consent.choices };
  if (p.stage === 'carded') return { reply, choices: flow.carded.choices };
  if (p.stage === 'banks') return { reply: p.banks.length > 0 ? (flow.banks.more_prompt ?? reply) : reply, choices: bankButtons(flow, p) };
  if (p.stage !== 'steps') return { reply };
  const step = flow.steps[p.step];
  return step ? question(flow, { ...p }, step, p.suggestions ?? []) : { reply };
}

export type IdVerdict = { ok: true } | { ok: false; reply: string };

/** Owner ID rules: is this set of ID photos enough? Pure, so the rules are the same every time. */
export function idVerdict(flow: Flow, seen: IdSeen[]): IdVerdict {
  const r = flow.id_rules;
  const t = flow.id_photo;
  const clear = seen.filter((s) => s.clear);
  const known = (s: IdSeen) => r.primary.includes(s.type) || s.type in r.pair || r.secondary.includes(s.type);

  if (clear.some((s) => r.primary.includes(s.type))) return { ok: true };

  const pairs = clear.filter((s) => s.type in r.pair);
  for (const main of pairs) {
    const rule = r.pair[main.type]!;
    const sides = new Set(clear.filter((s) => s.type === main.type).map((s) => s.side));
    const bothSides = sides.has('both') || (sides.has('front') && sides.has('back'));
    if (rule.both_sides && !bothSides) return { ok: false, reply: t.need_back_reply };
    const others = clear.filter((s) => s.type !== main.type && known(s));
    if (others.length === 0) return { ok: false, reply: rule.second_needs_signature ? t.need_signature_reply : t.need_second_reply };
    if (rule.second_needs_signature && !others.some((s) => s.has_signature)) return { ok: false, reply: t.need_signature_reply };
    return { ok: true };
  }

  // Only the newest photo decides "blurry": an older bad photo (or a picture that is not an ID) must not block
  // every clear ID sent after it.
  if (seen.length > 0 && !seen.at(-1)!.clear) return { ok: false, reply: t.unclear_reply };
  if (clear.length > 0) return { ok: false, reply: t.need_primary_reply };
  return { ok: false, reply: t.need_image_reply };
}
