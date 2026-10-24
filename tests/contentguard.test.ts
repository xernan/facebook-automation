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
    expect(contentProblem("Mother's maiden name?")).toBeDefined();
  });

  it('allows the normal flow wording', () => {
    for (const t of [
      'Hi! Salamat sa pag-message sa CARD MAX. Tutulungan ka naming mag-apply ng credit card, libre.',
      'Saan ka pinanganak?',
      'Buong pangalan ng nanay mo? (First, Middle, Last)',
      'Optional: TIN number mo? Pindutin ang Skip kung hindi mo alam.',
      'Mobile number ng reference mo?',
      'Pakisend ang photo ng valid ID mo.',
      'Ang bangko pa rin ang magdedesisyon sa approval.',
      'The RCBC Credit Card No Annual Fee For Life promo is here!',
    ])
      expect(contentProblem(t)).toBeUndefined();
  });

  it('refuses engagement bait but allows a real question', () => {
    for (const t of [
      '💬 TAG ang isang kaibigan na naghahanap ng EastWest credit card!',
      'SHARE MO SA FRIENDS: Sino sa mga kakilala mo ang naghahanap?',
      'Comment YES kung gusto mo',
      'Like if you agree',
      'React kung carded ka na',
    ])
      expect(contentProblem(t)).toBeDefined();
    for (const t of [
      'Alin sa mga benefits na ito ang pinaka-kailangan mo ngayon?',
      'Ano ang paborito mong credit card ngayon? I-comment sa ibaba.',
      'Gusto mo ng card na pang-travel o pang-grocery?',
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

describe('one door to Facebook', () => {
  it('only graph.ts (plus login/oauth for the token) talks to graph.facebook.com, so every send passes the guard', async () => {
    const { readdirSync, readFileSync: rf } = await import('node:fs');
    const offenders = readdirSync('src')
      .filter((f) => f.endsWith('.ts') && !['graph.ts', 'login.ts', 'oauth.ts'].includes(f))
      .filter((f) => /graph\.facebook\.com|facebook\.com\/v\d/.test(rf(path.join('src', f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('login/oauth only read the token endpoints (no posting)', () => {
    for (const f of ['src/login.ts', 'src/oauth.ts']) expect(readFileSync(f, 'utf8')).not.toMatch(/\/(messages|feed|photos|videos|comments)\b/);
  });
});
