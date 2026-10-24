import { z } from 'zod';
import { extractBanks, extractEmails, extractPhones } from './leads.js';

// Messenger application flow: a fixed script the Page follows with each person, one state per person.
// The qualifier rules (no card -> reject with cooldown, all excluded banks -> stop) are decided here in
// code, never by the AI, so they are the same every time. Texts live in the owner's flow file
// (FB_FLOW_FILE, git-ignored); flow.example.json shows the shape.

const msg = z.string().trim().min(1).max(2000);
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
            validate: z.enum(['mobile', 'email', 'tin', 'sss_gsis', 'date', 'number', 'yes_no']).optional(),
            /** A clear "yes" adds this flag to the lead (e.g. pending_application), so the client sees it. */
            flag_if_yes: z.string().regex(/^[a-z_]+$/).optional(),
            invalid_reply: msg.optional(),
            /** Fixed buttons shown with the question. Typing an answer still works. */
            choices,
            /**
             * Steps sharing a group are optional together: a skip word ("skip", "laktaw", "wala") on the
             * first one skips the whole group.
             */
            optional_group: z.string().regex(/^[a-z_]+$/).optional(),
            /** Claude may attach suggestions found in public info (e.g. a branch address) to this question. */
            suggest: z.boolean().optional(),
          })
          .refine((s) => !s.validate || s.invalid_reply, { message: 'invalid_reply is required with validate' })
          .refine((s) => !s.flag_if_yes || s.validate === 'yes_no', { message: 'flag_if_yes needs validate "yes_no"' })
          .strict(),
      )
      .min(1),
    id_photo: z.object({ prompt: msg, need_image_reply: msg }).strict(),
    done_reply: msg,
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
  /** Suggestions shown with the current question; a reply "1".."n" picks one. */
  suggestions?: string[];
  updated_at: string;
  /** A reply saved but not sent yet (see fb_flow_answer). */
  outbox?: { text: string; for_messages: string[]; choices?: string[] };
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
}

export const newPerson = (now: Date): Person => ({
  stage: 'new',
  step: 0,
  answers: {},
  banks: [],
  married: false,
  updated_at: now.toISOString(),
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
  }
}

/** Clean suggestions from Claude: trimmed, unique, at most 5, each one line. */
export function cleanSuggestions(list: string[] | undefined): string[] {
  const out = [...new Set((list ?? []).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length > 0 && s.length <= 200))];
  return out.slice(0, 5);
}

interface Question {
  reply: string;
  choices?: string[];
}

/** The question for `step`, with its buttons, or with numbered suggestions when there are any. */
function question(flow: Flow, p: Person, step: Step, suggestions: string[]): Question {
  delete p.suggestions;
  const base = step.optional_group && isFirstOfGroup(flow, p.step) ? [...(step.choices ?? []), flow.skip_choice] : step.choices;
  if (step.suggest && suggestions.length > 0) {
    p.suggestions = suggestions;
    const list = suggestions.map((s, i) => `${i + 1}) ${s}`).join('\n');
    return { reply: `${step.prompt}\n\n${list}`, choices: [...suggestions.map((_, i) => String(i + 1)), flow.other_choice] };
  }
  return { reply: step.prompt, choices: base };
}

function isFirstOfGroup(flow: Flow, i: number): boolean {
  const g = flow.steps[i]?.optional_group;
  return !!g && flow.steps[i - 1]?.optional_group !== g;
}

/** Moves `p` to the next question that applies from step `from` and returns it (or the ID photo prompt). */
function goToStep(flow: Flow, p: Person, from: number, suggestions: string[] = []): Question {
  let i = from;
  while (flow.steps[i]?.only_if_married && !p.married) i++;
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
      return ask(flow.banks.prompt);
    }

    case 'banks': {
      const banks = extractBanks(text);
      if (banks.length === 0) return ask(flow.banks.unknown_reply);
      p.banks = banks;
      const exclude = flow.banks.exclude_if_all.map((b) => b.toLowerCase());
      if (exclude.every((b) => banks.some((x) => x.toLowerCase() === b))) {
        p.stage = 'excluded';
        return ask(flow.banks.excluded_reply);
      }
      return askQ(goToStep(flow, p, 0, suggestions));
    }

    case 'steps': {
      const step = flow.steps[p.step];
      if (!step) return askQ(goToStep(flow, p, p.step, suggestions)); // flow file changed under this person
      if (!text) return askQ(question(flow, p, step, p.suggestions ?? []));

      let answer = text;
      if (p.suggestions?.length) {
        const shown = p.suggestions;
        if (answer.toLowerCase() === flow.other_choice.toLowerCase()) {
          delete p.suggestions;
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
      p.answers[step.key] = answer;
      if (step.sets_married) p.married = MARRIED.test(answer);
      if (step.flag_if_yes && parseYesNo(answer) === 'yes') p.flags = [...new Set([...(p.flags ?? []), step.flag_if_yes])];
      return askQ(goToStep(flow, p, p.step + 1, suggestions));
    }

    case 'id_photo':
      if (!input.image_url) return ask(flow.id_photo.need_image_reply);
      p.id_image_url = input.image_url;
      p.stage = 'done';
      return { person: p, reply: flow.done_reply, completed: true };

    case 'done':
    case 'excluded':
      return { person: prev };
  }
}

/** The step a person would be asked next if `input` answered the current one (for Claude to prepare suggestions). */
export function nextStepIf(flow: Flow, p: Person, input: Incoming, now: Date, cooldownDays: number): Step | undefined {
  const r = advance(flow, p, input, now, cooldownDays);
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
