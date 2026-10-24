import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSafeContent, contentProblem } from '../src/contentguard.js';
import { loadFlow } from '../src/flowstore.js';
import { GraphClient } from '../src/graph.js';
import { testConfig } from './helpers.js';

describe('Community Standards guard', () => {
  it('refuses the greeting that got the Page restricted, and other phishing/scam wording', () => {
    expect(contentProblem('Hindi namin kailanman hihingin ang OTP, CVV, PIN o card number mo.')).toBeDefined();
    expect(contentProblem('Send your account no. please')).toBeDefined();
    expect(contentProblem('Guaranteed approval!')).toBeDefined();
    expect(contentProblem('Siguradong approved ka')).toBeDefined();
    expect(contentProblem('May processing fee na 500')).toBeDefined();
    expect(contentProblem('What is your password')).toBeDefined();
  });

  it('allows the normal flow wording', () => {
    for (const t of [
      'Hi! Salamat sa pag-message sa CARD MAX. Tutulungan ka naming mag-apply ng credit card, libre.',
      'Saan ka pinanganak?',
      'Optional: TIN number mo? Pindutin ang Skip kung hindi mo alam.',
      'Mobile number ng reference mo?',
      'Pakisend ang photo ng valid ID mo.',
      'Ang bangko pa rin ang magdedesisyon sa approval.',
    ])
      expect(contentProblem(t)).toBeUndefined();
  });

  it('reads Messenger JSON text and button titles', () => {
    expect(() => assertSafeContent({ message: JSON.stringify({ text: 'ok', quick_replies: [{ title: 'Send OTP' }] }) })).toThrow(/Community Standards/);
    expect(() => assertSafeContent({ message: JSON.stringify({ text: 'Hello' }) })).not.toThrow();
    expect(() => assertSafeContent({ caption: 'Guaranteed approval' })).toThrow();
  });

  it('a flow file with a bad text does not load', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cg-'));
    const f = JSON.parse(readFileSync('flow.example.json', 'utf8'));
    f.greeting = 'Hi! We never ask your OTP or CVV.';
    writeFileSync(path.join(dir, 'flow.json'), JSON.stringify(f));
    expect(() => loadFlow(path.join(dir, 'flow.json'))).toThrow(/greeting/);
  });

  it('the live flow.json passes (when present)', () => {
    try {
      readFileSync('flow.json');
    } catch {
      return;
    }
    expect(() => loadFlow('flow.json')).not.toThrow();
  });

  it('graph.post refuses before any network call', async () => {
    const fetchFn = async () => {
      throw new Error('network must not be called');
    };
    const g = new GraphClient(testConfig(), fetchFn as any);
    await expect(g.post('1', '1/messages', { message: JSON.stringify({ text: 'Give me your CVV' }) })).rejects.toThrow(/Not sent/);
    await expect(g.post('1', '1/feed', { message: 'Guaranteed approval' })).rejects.toThrow(/Not sent/);
  });

  it('Messenger is off unless the owner turns it on (default), even for a clean message', async () => {
    const fetchFn = async () => {
      throw new Error('network must not be called');
    };
    const off = new GraphClient(testConfig({ FB_MESSENGER_LIVE: '' }), fetchFn as any);
    await expect(off.post('1', '1/messages', { message: JSON.stringify({ text: 'Hello' }) })).rejects.toThrow(/Messenger sending is off/);
  });
});
