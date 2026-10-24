import { z } from 'zod';
import { extractBanks } from './leads.js';

// Messenger application flow: a fixed script the Page follows with each person, one state per person.
// The qualifier rules (no card -> reject with cooldown, all excluded banks -> stop) are decided here in
// code, never by the AI, so they are the same every time. Texts live in the owner's flow file
// (FB_FLOW_FILE, git-ignored); flow.example.json shows the shape.

const msg = z.string().trim().min(1).max(2000);

export const flowSchema = z
  .object({
    greeting: msg,
    consent: z.object({ prompt: msg, decline_reply: msg }).strict(),
    carded: z.object({ prompt: msg, reject_reply: msg }).strict(),
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
          })
          .strict(),
      )
      .min(1),
    id_photo: z.object({ prompt: msg, need_image_reply: msg }).strict(),
    done_reply: msg,
    yes_no_reply: msg,
  })
  .strict();

export type Flow = z.infer<typeof flowSchema>;

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
  consent_at?: string;
  cooldown_until?: string;
  id_image_url?: string;
  updated_at: string;
  /** A reply saved but not sent yet (see fb_flow_answer). */
  outbox?: { text: string; for_messages: string[] };
}

export interface Incoming {
  text: string;
  image_url?: string;
}

export interface Advance {
  person: Person;
  /** Text to send now. Undefined = the script has nothing to say (Claude answers freely). */
  reply?: string;
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

/** "yes", "no", or undefined when unclear (both kinds of words, or neither). Unclear is asked again, never rejected. */
export function parseYesNo(text: string): 'yes' | 'no' | undefined {
  const words = text.toLowerCase().normalize('NFKD').match(/[a-z]+/g) ?? [];
  const yes = words.some((w) => YES.has(w));
  const no = words.some((w) => NO.has(w));
  if (yes === no) return undefined;
  return yes ? 'yes' : 'no';
}

const MARRIED = /\b(married|kasal|may\s+asawa)\b/i;

/** Moves `p` to the next question that applies from step `from` and returns its prompt (or the ID photo prompt). */
function goToStep(flow: Flow, p: Person, from: number): string {
  let i = from;
  while (flow.steps[i]?.only_if_married && !p.married) i++;
  const step = flow.steps[i];
  if (step) {
    p.stage = 'steps';
    p.step = i;
    return step.prompt;
  }
  p.stage = 'id_photo';
  return flow.id_photo.prompt;
}

/** Feed one message (or several joined) from the person into the script. Pure: no I/O. */
export function advance(flow: Flow, prev: Person, input: Incoming, now: Date, cooldownDays: number): Advance {
  const p: Person = { ...prev, answers: { ...prev.answers }, banks: [...prev.banks], updated_at: now.toISOString() };
  const text = input.text.trim();
  const ask = (reply: string): Advance => ({ person: p, reply });

  switch (p.stage) {
    case 'rejected':
      if (p.cooldown_until && now < new Date(p.cooldown_until)) return { person: prev };
      // Cooldown over: start again.
      return advance(flow, newPerson(now), input, now, cooldownDays);

    case 'new':
    case 'declined':
      p.stage = 'consent';
      return ask(`${flow.greeting}\n\n${flow.consent.prompt}`);

    case 'consent': {
      const a = parseYesNo(text);
      if (!a) return ask(`${flow.yes_no_reply}\n\n${flow.consent.prompt}`);
      if (a === 'no') {
        p.stage = 'declined';
        return ask(flow.consent.decline_reply);
      }
      p.stage = 'carded';
      p.consent_at = now.toISOString();
      return ask(flow.carded.prompt);
    }

    case 'carded': {
      const a = parseYesNo(text);
      if (!a) return ask(`${flow.yes_no_reply}\n\n${flow.carded.prompt}`);
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
      return ask(goToStep(flow, p, 0));
    }

    case 'steps': {
      const step = flow.steps[p.step];
      if (!step) return ask(goToStep(flow, p, p.step)); // flow file changed under this person
      if (!text) return ask(step.prompt);
      p.answers[step.key] = text;
      if (MARRIED.test(text)) p.married = true;
      return ask(goToStep(flow, p, p.step + 1));
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
