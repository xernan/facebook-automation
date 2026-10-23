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

export interface ContactLead {
  source: 'messenger' | 'comment';
  name: string;
  /** Messenger: page-scoped id (PSID). Comment: commenter id, when Meta shares it. */
  person_id?: string;
  emails: string[];
  phones: string[];
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
    last_time: c.created_time,
    last_text: text.slice(0, 300),
    ref_id: c.id,
    post_id: postId,
  };
}

export function contactLeadsToCsv(leads: ContactLead[]): string {
  const header = ['source', 'name', 'phones', 'emails', 'last_time', 'last_text', 'person_id', 'ref_id', 'post_id'];
  const rows = leads.map((l) => [
    l.source,
    l.name,
    l.phones.join('; '),
    l.emails.join('; '),
    l.last_time,
    l.last_text,
    l.person_id,
    l.ref_id,
    l.post_id,
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
