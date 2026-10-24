import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { companyKey, forgetPhone, loadPhonebook, lookupPhone, rememberPhone } from '../src/phonebook.js';

const dir = () => mkdtempSync(path.join(tmpdir(), 'pb-'));
const SRC = 'https://www.jollibee.com.ph/stores/alabang';

describe('company phone directory', () => {
  it('finds the number for the same company and branch city, written differently', async () => {
    const d = dir();
    await rememberPhone(d, { company: 'Jollibee Foods Corp.', city: 'Muntinlupa City', phone: '(02) 8123-0000', source: SRC });
    expect((await lookupPhone(d, 'jollibee', 'Muntinlupa'))?.phone).toBe('(02) 8123-0000');
    expect((await lookupPhone(d, 'Jollibee Alabang', 'muntinlupa city'))?.source).toBe(SRC);
  });

  it('never uses a number from another city or another company (no guessing)', async () => {
    const d = dir();
    await rememberPhone(d, { company: 'Jollibee', city: 'Muntinlupa', phone: '(02) 8123-0000', source: SRC });
    expect(await lookupPhone(d, 'Jollibee', 'Cebu City')).toBeUndefined();
    expect(await lookupPhone(d, 'Jolli Bee', 'Muntinlupa')).toBeUndefined();
    expect(await lookupPhone(d, 'Chowking', 'Muntinlupa')).toBeUndefined();
    expect(await lookupPhone(d, 'Jollibee', '')).toBeUndefined();
    await rememberPhone(d, { company: 'San Miguel Corp', city: 'Muntinlupa', phone: '(02) 8632-3000', source: SRC });
    expect(await lookupPhone(d, 'San Roque Hospital', 'Muntinlupa')).toBeUndefined();
    expect(await lookupPhone(dir(), 'Jollibee', 'Muntinlupa')).toBeUndefined();
  });

  it('a number needs a source; saving again replaces it; remove works', async () => {
    const d = dir();
    await expect(rememberPhone(d, { company: 'Jollibee', city: 'Muntinlupa', phone: '(02) 8123-0000', source: '' })).rejects.toThrow();
    await rememberPhone(d, { company: 'Jollibee', city: 'Muntinlupa', phone: '(02) 8123-0000', source: SRC });
    await rememberPhone(d, { company: 'Jollibee Foods', city: 'Muntinlupa City', phone: '(02) 8999-1111', source: 'Entered by owner' });
    expect(await loadPhonebook(d)).toHaveLength(1);
    expect((await lookupPhone(d, 'Jollibee', 'Muntinlupa'))?.phone).toBe('(02) 8999-1111');
    expect(await forgetPhone(d, 'Jollibee Foods', 'Muntinlupa City')).toBe(true);
    expect(await loadPhonebook(d)).toHaveLength(0);
  });

  it('a broken directory file is reported, not silently emptied', async () => {
    const d = dir();
    writeFileSync(path.join(d, 'company-phones.json'), '{oops');
    await expect(loadPhonebook(d)).rejects.toThrow(/invalid/);
    expect(readFileSync(path.join(d, 'company-phones.json'), 'utf8')).toBe('{oops');
  });

  it('company names lose suffixes and accents', () => {
    expect(companyKey('Nestlé Philippines, Inc.')).toBe('nestle');
  });
});
