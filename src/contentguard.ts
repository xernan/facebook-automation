// Meta Community Standards guard: every text this app sends to Facebook (messages, posts, captions, comments) is
// checked first. Wording that Meta's systems read as phishing or a credit scam is refused before it leaves.
// Background: the CARD MAX Page was restricted from messaging for 28 days (Oct 2026) after one greeting that
// said "we will never ask for your OTP, CVV, PIN or card number" next to a credit card offer.
// Rules: Fraud, Scams and Deceptive Practices (no guaranteed approval, no upfront fees), Cybersecurity (no
// phishing-like requests), Meta Platform Terms 5.6.6 (never ask for card or financial account numbers).

const RULES: { re: RegExp; why: string }[] = [
  { re: /\b(otp|cvv|cvc|pin|mpin)\b/i, why: 'mentions OTP/CVV/PIN (reads like phishing, even when saying we never ask for it)' },
  { re: /\b(password|passcode|log\s?in details)\b/i, why: 'mentions passwords or login details' },
  // Account-recovery wording (Community Standards, Cybersecurity: social engineering). Ask "pangalan ng nanay" plainly.
  { re: /\bmaiden\s+name\b|\bsecurity\s+question|\bverification\s+code/i, why: 'sounds like an account-recovery question' },
  // "no." / "no:" / "#" only, so "Credit Card No Annual Fee" is fine.
  { re: /\b(card|account|acct)\s*(numbers?|no\.|no:|#)/i, why: 'mentions card or account numbers' },
  { re: /\b(guarantee[ds]?|garantisado|siguradong\s+approv\w*|sure\s+approv\w*|100\s*%\s*approv\w*|instant\s+approv\w*|auto\s*approv\w*)/i, why: 'promises approval (banks decide)' },
  { re: /\b(processing|application|upfront|advance|reservation)\s+fee\b/i, why: 'mentions an upfront fee' },
  { re: /\b(no\s+income|walang\s+income|kahit\s+walang\s+trabaho)\b/i, why: 'implies skipping bank requirements' },
];

/** The reason this text breaks a rule, or undefined when it is fine to send. */
export function contentProblem(text: string): string | undefined {
  return RULES.find((r) => r.re.test(text))?.why;
}

/** Texts inside Graph POST params: message (plain or Messenger JSON), caption, description, title. */
export function outgoingTexts(params: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  for (const k of ['message', 'caption', 'description', 'title', 'name']) {
    const v = params?.[k];
    if (typeof v !== 'string') continue;
    try {
      const j = JSON.parse(v);
      if (j && typeof j === 'object') {
        if (typeof j.text === 'string') out.push(j.text);
        for (const q of Array.isArray(j.quick_replies) ? j.quick_replies : []) if (typeof q?.title === 'string') out.push(q.title);
        continue;
      }
    } catch {
      // plain text
    }
    out.push(v);
  }
  return out;
}

/** Throws before anything that breaks a rule is sent. */
export function assertSafeContent(params: Record<string, unknown> | undefined): void {
  for (const t of outgoingTexts(params)) {
    const why = contentProblem(t);
    if (why) throw new Error(`Not sent: the text ${why}. Meta can restrict the Page for this (Community Standards). Reword it.`);
  }
}
