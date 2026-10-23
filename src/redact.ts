// Scrubs anything token-shaped before text leaves the process (errors, logs, tool output).
const PATTERNS: RegExp[] = [
  /(access_token|appsecret_proof|client_secret|fb_exchange_token)=[^&\s"']+/gi,
  /\bEAA[A-Za-z0-9]{20,}\b/g,
];

export function redact(text: string, secrets: (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join('[REDACTED]');
  }
  for (const p of PATTERNS) {
    out = out.replace(p, (m) => (m.includes('=') ? `${m.split('=')[0]}=[REDACTED]` : '[REDACTED]'));
  }
  return out;
}
