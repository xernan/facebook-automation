import { describe, expect, it } from 'vitest';
import { formFromLead, type Lead } from '../src/application.js';
import { placeProblems } from '../src/placecheck.js';

describe('place names on the form', () => {
  it('accepts names on our list, however the city is written', () => {
    expect(
      placeProblems({
        birth_town: 'Malolos, Bulacan',
        home: { barangay: 'Bayanan', city: 'Muntinlupa', province: 'Metro Manila' },
        company: { city: 'City of Malolos', province: 'Bulacan' },
      }),
    ).toEqual([]);
    expect(placeProblems({ birth_town: 'Malolos Bulacan' })).toEqual([]);
  });

  it('flags a misspelled city, province and barangay with the likely name', () => {
    expect(placeProblems({ home: { city: 'Muntinlua', province: 'Metro Manila' } })[0]).toMatch(/home city "Muntinlua".*Muntinlupa/);
    expect(placeProblems({ home: { province: 'Bulakan' } })[0]).toMatch(/home province "Bulakan".*Bulacan/);
    expect(placeProblems({ company: { barangay: 'Bayanann', city: 'Muntinlupa', province: 'Metro Manila' } })[0]).toMatch(/office barangay "Bayanann".*Bayanan/);
    expect(placeProblems({ birth_town: 'Xyzzyville' })[0]).toMatch(/place of birth "Xyzzyville"/);
  });

  it('flags a city in the wrong province', () => {
    expect(placeProblems({ home: { city: 'Malolos', province: 'Metro Manila' } })[0]).toMatch(/not in Metro Manila/);
  });
});

describe('spelling fixes from finalize', () => {
  const lead: Lead = { psid: '1', completed_at: '2026-10-31T00:00:00Z', banks: [], married: false, answers: { place_of_birth: 'Malolos Bulakan' } };

  it('uses the corrected place of birth and shows each fix to the owner', () => {
    const { form, defaults } = formFromLead(lead, { birth_town: 'Malolos, Bulacan', spelling_fixes: ['Bulakan -> Bulacan'] }, new Date('2026-10-31'));
    expect(form.birth_town).toBe('Malolos, Bulacan');
    expect(defaults).toContain('Spelling corrected: Bulakan -> Bulacan');
  });
});
