import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { ageOn, buildApplication, yearsFrom, type Lead } from '../src/application.js';
import { finalizeLead, folderName, listApplicants, saveSettings } from '../src/leadout.js';
import { combText, formatPdfDate, pdfDigits } from '../src/pdf.js';

const NOW = new Date('2026-10-25T13:00:00Z');
const lead = (o: Partial<Lead> = {}): Lead => ({
  psid: '999',
  completed_at: '2026-10-25T13:00:00.000Z',
  banks: ['BDO', 'Metrobank'],
  married: false,
  answers: {
    place_of_birth: 'Marilao, Bulacan',
    civil_status: 'single',
    email: 'juan@example.com',
    mobile: '0917 123 1586',
    mothers_maiden_name: 'Maria Cruz',
    employer_name: 'Jollibee',
    position: 'Store Manager',
    years_with_employer: '5',
  },
  id_review: [{ type: 'umid', side: 'front', clear: true, has_signature: true }],
  ...o,
});
const details = { first_name: 'Juan', last_name: 'Dela Cruz', birthday: '1990-05-31', gender: 'Male' as const, nationality: 'Filipino' };

describe('owner rules in buildApplication', () => {
  it('PDFs only for banks the person has no card with (Metrobank card -> EastWest + China Bank)', () => {
    expect(buildApplication(lead(), details, NOW).banks).toEqual(['eastwest', 'chinabank']);
  });

  it('a pending application at a bank still gets a PDF (flag does not remove banks)', () => {
    expect(buildApplication(lead({ banks: ['BDO'], flags: ['pending_application'] }), details, NOW).banks).toEqual([
      'metrobank',
      'eastwest',
      'chinabank',
    ]);
  });

  it('over 25: Owned, years of stay = age - 21; total years working = age - 21', () => {
    const d = buildApplication(lead(), details, NOW).data; // age 36
    expect(d.home_ownership).toBe('Owned');
    expect(d.years_of_stay).toBe('15');
    expect(d.total_years_working).toBe('15');
  });

  it('25 or younger: Living with parents, years of stay = full age', () => {
    const d = buildApplication(lead(), { ...details, birthday: '2001-01-10' }, NOW).data; // age 25
    expect(d.home_ownership).toBe('Living with parents');
    expect(d.years_of_stay).toBe('25');
  });

  it('date hired = completion month, year minus years with employer', () => {
    expect(buildApplication(lead(), details, NOW).data.date_hired).toBe('2021-10-01');
  });

  it('card number is "Refuse to give"; issuer is their existing bank', () => {
    const d = buildApplication(lead(), details, NOW).data;
    expect(d.other_card_number).toBe('Refuse to give');
    expect(d.other_card_company).toBe('BDO');
  });

  it('never invents income, TIN or SSS: blank and listed as missing', () => {
    const b = buildApplication(lead(), details, NOW);
    expect(b.data.gross_income).toBeUndefined();
    expect(b.data.tin_number).toBeUndefined();
    expect(b.data.gsis_sss_number).toBeUndefined();
    expect(b.missing).toEqual(expect.arrayContaining(['Gross annual income', 'TIN', 'SSS/GSIS number']));
  });

  it('TIN read from an ID is used', () => {
    expect(buildApplication(lead(), { ...details, tin: '123-456-789' }, NOW).data.tin_number).toBe('123-456-789');
  });

  it('without a birthday nothing age-based is guessed', () => {
    const b = buildApplication(lead(), { ...details, birthday: undefined }, NOW);
    expect(b.data.home_ownership).toBeUndefined();
    expect(b.missing.join()).toMatch(/need birthday/);
  });

  it('home address from the ID is marked as a default; unsure zip is listed', () => {
    const b = buildApplication(lead(), { ...details, home: { street: '1 A St', city: 'Quezon City', zip: '1100', zip_sure: false }, home_from_id: true }, NOW);
    expect(b.defaults).toContain('Home address taken from the ID');
    expect(b.missing.join()).toMatch(/zip code \(check/);
  });

  it('spouse only when married; education default is listed', () => {
    expect(buildApplication(lead({ answers: { ...lead().answers, spouse_name: 'Ana' } }), details, NOW).data.spouse_name).toBeUndefined();
    const m = buildApplication(lead({ married: true, answers: { ...lead().answers, spouse_name: 'Ana' } }), details, NOW);
    expect(m.data.spouse_name).toBe('Ana');
    expect(m.defaults.join()).toMatch(/Education = College/);
  });

  it.each([
    ['5', 5],
    ['<1', 0],
    ['6-10', 6],
    ['10+', 10],
    ['matagal', undefined],
  ])('yearsFrom(%s) = %s', (a, n) => expect(yearsFrom(a)).toBe(n));

  it('ageOn counts the birthday correctly', () => {
    expect(ageOn('1990-10-26', NOW)).toBe(35);
    expect(ageOn('1990-10-25', NOW)).toBe(36);
  });
});

describe('pdf helpers', () => {
  it('dates, mobile digit boxes and comb boxes', () => {
    expect(formatPdfDate('1990-05-31', 'mm')).toBe('05');
    expect(formatPdfDate('1990-05-31', 'mmyy')).toBe('05/90');
    expect(formatPdfDate('1990-05-31')).toBe('05/31/1990');
    expect(pdfDigits('+63 917 123 1586', 4, 11)).toBe('1231586');
    expect(combText('123-456-789-000', 12)).toBe('123456789000');
    expect(combText('Juan', 10)).toBe('Juan');
  });
});

async function template(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  const form = pdf.getForm();
  let y = 760;
  const text = (n: string) => form.createTextField(n).addToPage(page, { x: 20, y: (y -= 22), width: 200, height: 18 });
  const box = (n: string) => form.createCheckBox(n).addToPage(page, { x: 240, y: (y -= 22), width: 12, height: 12 });
  ['first_name', 'last_name', 'mother_maiden_name', 'birthday__fmt_mm', 'other_card_number', 'gross_income', 'tin_number', 'bank_only__source_of_funds_others', 'admin_only__agent_code', 'signature__image'].forEach(text);
  ['civil_status__checkbox__single', 'civil_status__checkbox__married', 'bank_only__education__checkbox__college', 'bank_only__card_choice__checkbox__cashbackvisa'].forEach(box);
  return pdf.save();
}

describe('finalizeLead', () => {
  it('fills the PDF, keeps income/TIN blank, removes the signature box, writes details + CLIENTS.xlsx', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fin-'));
    const tpl = mkdtempSync(path.join(tmpdir(), 'tpl-'));
    const bytes = await template();
    for (const b of ['metrobank', 'eastwest', 'chinabank']) writeFileSync(path.join(tpl, `${b}.pdf`), bytes);
    writeFileSync(path.join(dir, 'lead-999-x.json'), JSON.stringify(lead({ banks: ['BDO'] })));
    await saveSettings(dir, { agent_name: 'A', agent_code: 'T-1', card_choice: { metrobank: 'cashbackvisa' }, auto_print: false, printer: '' });

    const r = await finalizeLead(dir, tpl, 'lead-999-x.json', details, NOW);
    expect(r.pdfs).toEqual(['Metrobank.pdf', 'EastWest.pdf', 'China Bank.pdf']);
    const pdf = await PDFDocument.load(readFileSync(path.join(dir, r.folder, 'Metrobank.pdf')));
    const f = pdf.getForm();
    expect(f.getTextField('first_name').getText()).toBe('Juan');
    expect(f.getTextField('birthday__fmt_mm').getText()).toBe('05');
    expect(f.getTextField('other_card_number').getText()).toBe('Refuse to give');
    expect(f.getTextField('gross_income').getText()).toBeUndefined();
    expect(f.getTextField('tin_number').getText()).toBeUndefined();
    expect(f.getTextField('admin_only__agent_code').getText()).toBe('T-1');
    expect(f.getTextField('bank_only__source_of_funds_others').getText()).toBe('Salary');
    expect(f.getCheckBox('civil_status__checkbox__single').isChecked()).toBe(true);
    expect(f.getCheckBox('civil_status__checkbox__married').isChecked()).toBe(false);
    expect(f.getCheckBox('bank_only__education__checkbox__college').isChecked()).toBe(true);
    expect(f.getCheckBox('bank_only__card_choice__checkbox__cashbackvisa').isChecked()).toBe(true);
    expect(f.getFields().some((x) => x.getName().startsWith('signature__'))).toBe(false);

    // EastWest has no card choice set: not ticked.
    const ew = (await PDFDocument.load(readFileSync(path.join(dir, r.folder, 'EastWest.pdf')))).getForm();
    expect(ew.getCheckBox('bank_only__card_choice__checkbox__cashbackvisa').isChecked()).toBe(false);

    expect(readFileSync(path.join(dir, r.folder, 'MISSING.txt'), 'utf8')).toMatch(/Gross annual income/);
    const rows = await listApplicants(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Juan Dela Cruz');
    expect(readFileSync(path.join(dir, 'CLIENTS.xlsx')).length).toBeGreaterThan(1000);
  });

  it('folder names are safe on Windows', () => {
    expect(folderName('2026-10-25T13:00:00Z', 'Juan "J" <Cruz>/x', '9')).toBe('2026-10-25 Juan J Cruzx');
    expect(folderName('2026-10-25T13:00:00Z', '', '9')).toBe('2026-10-25 Applicant 9');
  });

  it('refuses a lead file name with a path in it', async () => {
    const { tools, callTool } = await import('../src/tools.js');
    const { testCtx } = await import('./helpers.js');
    const t = tools.find((x) => x.name === 'fb_lead_finalize')!;
    await expect(callTool(t, { lead_file: '../../.env', details: {} }, testCtx().ctx)).rejects.toThrow();
  });
});
