import { csvCell } from './files.js';

// Contact details people typed themselves in Messenger or comments. Personal data: exports/ only.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// PH mobile numbers: 09XX XXX XXXX, +63 9XX XXX XXXX, 639XXXXXXXXX (spaces, dots or dashes allowed).
const PH_MOBILE_RE = /(?<![\d+])(?:\+?63|0)[\s.-]?9\d{2}[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;

export function extractEmails(text: string): string[] {
  return [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))];
}

/** Phone numbers normalised to +639XXXXXXXXX. */
export function extractPhones(text: string): string[] {
  return [
    ...new Set(
      (text.match(PH_MOBILE_RE) ?? []).map((p) => {
        const d = p.replace(/\D/g, '');
        return `+63${d.slice(d.length - 10)}`;
      }),
    ),
  ];
}

// Card issuers people name when asking to apply (Card Max offers free credit card application help).
const BANKS: [string, RegExp][] = [
  ['BPI', /\bbpi\b/i],
  ['BDO', /\bbdo\b/i],
  ['Metrobank', /\bmetro\s?bank\b/i],
  ['RCBC', /\brcbc\b/i],
  ['EastWest', /\beast\s?west\b/i],
  ['UnionBank', /\bunion\s?bank\b|\bubp\b/i],
  ['Security Bank', /\bsecurity\s?bank\b|\bsecbank\b/i],
  ['PNB', /\bpnb\b/i],
  ['China Bank', /\bchina\s?bank\b/i],
  ['AUB', /\baub\b|\basia\s?united\b/i],
  ['Citi', /\bciti(bank)?\b/i],
  ['HSBC', /\bhsbc\b/i],
  ['Maybank', /\bmaybank\b/i],
  ['PSBank', /\bpsbank\b/i],
];

export function extractBanks(text: string): string[] {
  return BANKS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

const NOT_CARDED =
  /\bnon[\s-]?carded\b|\bnot\s+carded\b|\bwala\s+(pa\s+)?(akong\s+|ako\s+)?(cc|credit\s?card)\b|\bwalang\s+(cc|credit\s?card)\b|\bfirst\s+(time|card)\b|\bno\s+(cc|credit\s?card)\b/;
const CARDED =
  /\bcarded\b|\bmay\s+(na\s+)?(akong\s+)?(cc|credit\s?card)\b|\bexisting\s+(cc|card|credit\s?card)\b|\bhave\s+(a\s+)?(cc|credit\s?card)\b/;

/** "yes" = already has a credit card (carded), "no" = first card, undefined = not said. */
export function cardedStatus(text: string): 'yes' | 'no' | undefined {
  const t = text.toLowerCase();
  if (NOT_CARDED.test(t)) return 'no';
  if (CARDED.test(t)) return 'yes';
  return undefined;
}

export interface ContactLead {
  source: 'messenger' | 'comment';
  name: string;
  /** Messenger: page-scoped id (PSID). Comment: commenter id, when Meta shares it. */
  person_id?: string;
  emails: string[];
  phones: string[];
  /** Banks or cards they named. */
  banks: string[];
  carded?: 'yes' | 'no';
  last_time?: string;
  last_text: string;
  /** Messenger conversation id, or comment id (use it for a private reply). */
  ref_id: string;
  post_id?: string;
}

interface Msg {
  message?: string;
  created_time?: string;
  from?: { id?: string; name?: string };
}

/** One Messenger conversation -> a lead for the customer side (the Page's own messages are ignored). */
export function leadFromConversation(pageId: string, conv: any): ContactLead | undefined {
  const person = (conv.participants?.data ?? []).find((p: any) => p.id !== pageId);
  if (!person) return undefined;
  const theirs: Msg[] = (conv.messages?.data ?? []).filter((m: Msg) => m.from?.id && m.from.id !== pageId);
  const text = theirs.map((m) => m.message ?? '').join('\n');
  return {
    source: 'messenger',
    name: person.name ?? '',
    person_id: person.id,
    emails: extractEmails(`${text}\n${person.email ?? ''}`),
    phones: extractPhones(text),
    banks: extractBanks(text),
    carded: cardedStatus(text),
    last_time: theirs[0]?.created_time ?? conv.updated_time,
    last_text: (theirs[0]?.message ?? conv.snippet ?? '').slice(0, 300),
    ref_id: conv.id,
  };
}

export function leadFromComment(pageId: string, postId: string, c: any): ContactLead | undefined {
  if (!c.from?.id && !c.from?.name) return undefined; // Meta hides some commenters
  if (c.from?.id === pageId) return undefined; // the Page's own replies
  const text = c.message ?? '';
  return {
    source: 'comment',
    name: c.from?.name ?? '',
    person_id: c.from?.id,
    emails: extractEmails(text),
    phones: extractPhones(text),
    banks: extractBanks(text),
    carded: cardedStatus(text),
    last_time: c.created_time,
    last_text: text.slice(0, 300),
    ref_id: c.id,
    post_id: postId,
  };
}

export function contactLeadsToCsv(leads: ContactLead[]): string {
  const header = ['source', 'name', 'phones', 'emails', 'banks', 'carded', 'last_time', 'last_text', 'person_id', 'ref_id', 'post_id'];
  const rows = leads.map((l) => [
    l.source,
    l.name,
    l.phones.join('; '),
    l.emails.join('; '),
    l.banks.join('; '),
    l.carded,
    l.last_time,
    l.last_text,
    l.person_id,
    l.ref_id,
    l.post_id,
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
