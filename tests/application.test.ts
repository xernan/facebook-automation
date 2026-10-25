import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { ageOn, buildApplication, formatTin, splitName, yearsFrom, type Lead } from '../src/application.js';
import { lookupPhone, rememberPhone } from '../src/phonebook.js';
import { finalizeLead, folderName, listApplicants, saveForm, saveSettings } from '../src/leadout.js';
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

describe('TIN', () => {
  it('from the ID first, else the optional Messenger answer; formatted XXX-XXX-XXX', () => {
    expect(buildApplication(lead({ answers: { ...lead().answers, tin: '123 456 789' } }), details, NOW).data.tin_number).toBe('123-456-789');
    expect(buildApplication(lead({ answers: { ...lead().answers, tin: '111222333' } }), { ...details, tin: '999-888-777-000' }, NOW).data.tin_number).toBe('999-888-777-000');
    expect(buildApplication(lead(), details, NOW).data.best_time_to_call).toBe('9AM-5PM'); // owner default on every form
    // Department comes from the chat answer when Claude did not fill it (EastWest and Metrobank print it).
    expect(buildApplication(lead({ answers: { ...lead().answers, department: 'Operations' } }), { ...details, department: undefined }, NOW).data.department).toBe('Operations');
    expect(buildApplication(lead({ answers: { ...lead().answers, department: 'Operations' } }), { ...details, department: 'Sales' }, NOW).data.department).toBe('Sales');
    // Skipped: blank and in the missing list (never generated).
    const b = buildApplication(lead(), details, NOW);
    expect(b.data.tin_number).toBeUndefined();
    expect(b.missing).toContain('TIN');
    expect(formatTin('1234')).toBeUndefined();
  });
});

describe('owner rules in buildApplication', () => {
  it('self-employed ticks China Bank Self-Employed (Business), employed ticks Employed', () => {
    const self = buildApplication(lead(), { ...details, employment_type: 'Self-employed' }, NOW).data.employment_status;
    expect(self?.toLowerCase().replace(/[^a-z0-9]/g, '')).toBe('selfemployedbusiness');
    expect(buildApplication(lead(), { ...details, employment_type: 'Private Sector' }, NOW).data.employment_status).toBe('Employed');
  });

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

  it('every missing address part is listed so it gets followed up', () => {
    const b = buildApplication(lead(), { ...details, home: { street: '1 A St', city: 'Marilao', zip: '3019' }, company: { street: 'ATC', city: 'Muntinlupa' } }, NOW);
    expect(b.missing).toEqual(expect.arrayContaining(['Home barangay', 'Home province', 'Office barangay', 'Office province', 'Office zip code']));
    const full = buildApplication(
      lead(),
      { ...details, home: { street: '1 A St', barangay: 'Poblacion', city: 'Marilao', province: 'Bulacan', zip: '3019' }, company: { street: 'ATC', barangay: 'Ayala Alabang', city: 'Muntinlupa', province: 'Metro Manila', zip: '1780' } },
      NOW,
    );
    expect(full.missing.filter((m) => /Home|Office (street|barangay|city|province|zip)/.test(m))).toEqual([]);
  });

  it('spouse only when married; education default is listed', () => {
    expect(buildApplication(lead({ answers: { ...lead().answers, spouse_name: 'Ana' } }), details, NOW).data.spouse_name).toBeUndefined();
    const m = buildApplication(lead({ married: true, answers: { ...lead().answers, civil_status: 'married', spouse_name: 'Ana' } }), details, NOW);
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

  it('names are split for First / Middle / Last columns; Claude can override ambiguous ones', () => {
    expect(splitName('Maria Santos Cruz')).toEqual({ first: 'Maria', middle: 'Santos', last: 'Cruz' });
    expect(splitName('Ana Dela Cruz')).toEqual({ first: 'Ana', last: 'Dela Cruz' });
    expect(splitName('Maria Santos Dela Cruz')).toEqual({ first: 'Maria', middle: 'Santos', last: 'Dela Cruz' });
    expect(splitName('Juan Reyes De los Santos')).toEqual({ first: 'Juan', middle: 'Reyes', last: 'De los Santos' });
    expect(splitName('Ma. Luisa Garcia Sta. Maria')).toEqual({ first: 'Ma. Luisa', middle: 'Garcia', last: 'Sta. Maria' });
    expect(splitName('Jose San Juan')).toEqual({ first: 'Jose', last: 'San Juan' });
    expect(splitName('Ana Cruz')).toEqual({ first: 'Ana', last: 'Cruz' });
    expect(splitName('Ana')).toBeUndefined();
    const b = buildApplication(
      lead({ answers: { ...lead().answers, mothers_maiden_name: 'Maria Luisa Dela Cruz' } }),
      { ...details, mother_name_parts: { first: 'Maria Luisa', last: 'Dela Cruz' } },
      NOW,
    );
    expect(b.data.mother_maiden_name_first).toBe('Maria Luisa');
    expect(b.data.mother_maiden_name_middle).toBeUndefined();
    expect(b.data.mother_maiden_name_last).toBe('Dela Cruz');
  });

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
    await saveSettings(dir, { agent_name: 'A', agent_code: 'T-1', card_choice: { metrobank: 'cashbackvisa' }, auto_print: false, printer: '', text_bold: true, text_max_size: 14, text_uniform_size: 0, flatten: false });

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

  it('by default the PDF is flattened: no form boxes left, so every printer shows the answers', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flat-'));
    const tpl = mkdtempSync(path.join(tmpdir(), 'tpl-'));
    const bytes = await template();
    for (const b of ['metrobank', 'eastwest', 'chinabank']) writeFileSync(path.join(tpl, `${b}.pdf`), bytes);
    writeFileSync(path.join(dir, 'lead-999-x.json'), JSON.stringify(lead({ banks: ['BDO'] })));
    const r = await finalizeLead(dir, tpl, 'lead-999-x.json', details, NOW);
    const pdf = await PDFDocument.load(readFileSync(path.join(dir, r.folder, 'Metrobank.pdf')));
    expect(pdf.getForm().getFields()).toHaveLength(0);
    // No dangling widget references left on the page (Acrobat will not print those).
    expect(pdf.getPages()[0]!.node.Annots()).toBeUndefined();
  });

  it('name on card fits the bank boxes the owner way (drop middle initial, then the second given name)', async () => {
    const { cardName } = await import('../src/application.js');
    expect(cardName('Juan', 'Santos', 'Dela Cruz')).toBe('JUAN S. DELA CRUZ');
    expect(cardName('Juan', 'Santos', 'Dela Cruz', 21)).toBe('JUAN S. DELA CRUZ');
    expect(cardName('Maria Cristina', 'Santos', 'Dela Cruz', 21)).toBe('MARIA DELA CRUZ'); // 26 -> 22 -> 15
    expect(cardName('Xernan Bryan', 'Bautista', 'Reyes', 19)).toBe('XERNAN BRYAN REYES'); // drop M.I. only
    expect(cardName('Xernan Bryan', 'Bautista', 'Reyes', 15)).toBe('XERNAN REYES');
    expect(cardName('Maximiliano', '', 'Villanueva-Santiago', 19)).toBe('M. VILLANUEVA-SANTI');
    for (const max of [19, 21]) expect(cardName('Ma. Lourdes Josefina', 'Garcia', 'Dela Cruz Jr', max).length).toBeLessThanOrEqual(max);
  });

  it('every bank declaration question is ticked NO (owner default), nothing else', async () => {
    const { DECLARE_NO } = await import('../src/application.js');
    for (const n of ['existing_eastwest_client', 'existing_principal_cardholder', 'related_to_eastwest_officer', 'related_to_government_official', 'relatives_in_china_bank', 'related_to_metrobank_employee', 'close_ties_public_position'])
      expect(DECLARE_NO.test(`${n}__checkbox__no`), n).toBe(true);
    for (const n of ['existing_credit_card__checkbox__no', 'condo__checkbox__no', 'related_to_government_official__checkbox__yes'])
      expect(DECLARE_NO.test(n), n).toBe(false);
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([600, 200]);
    const form = pdf.getForm();
    const names = ['bank_only__related_to_government_official__checkbox__no', 'bank_only__related_to_government_official__checkbox__yes', 'bank_only__condo__checkbox__no'];
    names.forEach((n, i) => form.createCheckBox(n).addToPage(page, { x: 20 + i * 30, y: 100, width: 10, height: 10 }));
    const app = { banks: ['eastwest' as const], data: {}, bankOnly: { metrobank: {}, eastwest: {}, chinabank: {} }, missing: [], defaults: [] };
    const { fillBankPdf } = await import('../src/pdf.js');
    const { settingsSchema } = await import('../src/application.js');
    const out = await fillBankPdf('eastwest', await pdf.save(), app, settingsSchema.parse({ flatten: false }));
    const f = (await PDFDocument.load(out.bytes)).getForm();
    expect(names.map((n) => { try { return f.getCheckBox(n).isChecked(); } catch { return 'flattened'; } })).toEqual([true, false, false]);
  });

  it("Metrobank's printed name sits above the signature label, centered", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([600, 300]);
    pdf.getForm().createTextField('full_name').addToPage(page, { x: 75, y: 138, width: 350, height: 8 });
    const app = { banks: ['metrobank' as const], data: { full_name: 'JUAN DELA CRUZ' }, bankOnly: { metrobank: {}, eastwest: {}, chinabank: {} }, missing: [], defaults: [] };
    const { fillBankPdf } = await import('../src/pdf.js');
    const { settingsSchema } = await import('../src/application.js');
    const out = await fillBankPdf('metrobank', await pdf.save(), app, settingsSchema.parse({ text_uniform_size: 11.5 }));
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await getDocument({ data: new Uint8Array(out.bytes) }).promise;
    const item: any = (await (await doc.getPage(1)).getTextContent()).items.find((i: any) => i.str.includes('JUAN'));
    expect(item.transform[5]).toBeGreaterThanOrEqual(141); // 3 points higher than the template box
    const mid = item.transform[4] + item.width / 2;
    expect(Math.abs(mid - 250)).toBeLessThan(2); // centered in the box (75..425)
  });

  it('the PDF gets the shortened name, not a name cut in half', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([600, 200]);
    const f = pdf.getForm().createTextField('name_on_card');
    f.setMaxLength(21);
    f.enableCombing();
    f.addToPage(page, { x: 20, y: 100, width: 400, height: 20 });
    const data = { first_name: 'Maria Cristina', middle_name: 'Santos', last_name: 'Dela Cruz', name_on_card: 'MARIA CRISTINA S. DELA CRUZ' };
    const app = { banks: ['chinabank' as const], data, bankOnly: { metrobank: {}, eastwest: {}, chinabank: {} }, missing: [], defaults: [] };
    const { fillBankPdf } = await import('../src/pdf.js');
    const { settingsSchema } = await import('../src/application.js');
    const out = await fillBankPdf('chinabank', await pdf.save(), app, settingsSchema.parse({}));
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await getDocument({ data: new Uint8Array(out.bytes) }).promise;
    const text = (await (await doc.getPage(1)).getTextContent()).items.map((i: any) => i.str).join('').replace(/\s+/g, '');
    expect(text).toBe('MARIADELACRUZ');
  });

  it('a long address is printed in full even when the bank box has a character limit', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([600, 200]);
    const f = pdf.getForm().createTextField('street');
    f.setMaxLength(20);
    f.addToPage(page, { x: 20, y: 100, width: 500, height: 20 });
    const long = 'Blk 12 Lot 34 Unit 5678 Qwertyuiop Tower, 1234 Asdfghjkl Highway';
    const app = { banks: ['metrobank' as const], data: { street: long }, bankOnly: { metrobank: {}, eastwest: {}, chinabank: {} }, missing: [], defaults: [] };
    const { fillBankPdf } = await import('../src/pdf.js');
    const { settingsSchema } = await import('../src/application.js');
    const out = await fillBankPdf('metrobank', await pdf.save(), app, settingsSchema.parse({}));
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await getDocument({ data: new Uint8Array(out.bytes) }).promise;
    const text = (await (await doc.getPage(1)).getTextContent()).items.map((i: any) => i.str).join(' ');
    expect(text.replace(/\s+/g, ' ')).toContain(long);
  });

  it('editing the Default Form saves it, rechecks missing items and remakes the PDFs from it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'form-'));
    const tpl = mkdtempSync(path.join(tmpdir(), 'tpl-'));
    const bytes = await template();
    for (const b of ['metrobank', 'eastwest', 'chinabank']) writeFileSync(path.join(tpl, `${b}.pdf`), bytes);
    writeFileSync(path.join(dir, 'lead-999-x.json'), JSON.stringify(lead({ banks: ['BDO'] })));
    await saveSettings(dir, { agent_name: '', agent_code: '', card_choice: {}, auto_print: false, printer: '', text_bold: true, text_max_size: 14, text_uniform_size: 0, flatten: false });
    const r = await finalizeLead(dir, tpl, 'lead-999-x.json', details, NOW);
    const folder = path.basename(r.folder);
    const before = JSON.parse(readFileSync(path.join(dir, r.folder, 'details.json'), 'utf8'));
    expect(before.form.first_name).toBe('Juan');
    expect(before.missing).toContain('TIN');

    const out = await saveForm(dir, tpl, folder, { ...before.form, first_name: 'Pedro', tin_number: '123-456-789', mother_maiden_name: 'Rosa Cruz' });
    expect(out.missing).not.toContain('TIN');
    const after = JSON.parse(readFileSync(path.join(dir, r.folder, 'details.json'), 'utf8'));
    expect(after.form.first_name).toBe('Pedro');
    expect(after.data.full_name).toBe('Pedro Dela Cruz');
    expect(after.printed).toBe(false);
    const f = (await PDFDocument.load(readFileSync(path.join(dir, r.folder, 'Metrobank.pdf')))).getForm();
    expect(f.getTextField('first_name').getText()).toBe('Pedro');
    expect(f.getTextField('tin_number').getText()).toBe('123-456-789');
    expect(f.getTextField('mother_maiden_name').getText()).toBe('Rosa Cruz');
    await expect(saveForm(dir, tpl, folder, { ...before.form, not_a_field: 'x' } as any)).rejects.toThrow();
  });

  it('office phone: a number found online is saved to the directory; the next client from that branch gets it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ph-'));
    const tpl = mkdtempSync(path.join(tmpdir(), 'tpl-'));
    writeFileSync(path.join(dir, 'lead-999-x.json'), JSON.stringify(lead({ banks: ['BDO'] })));
    const company = { street: 'ATC', city: 'Muntinlupa', province: 'Metro Manila' };
    await finalizeLead(dir, tpl, 'lead-999-x.json', { ...details, company, employer_phone: '(02) 8123-0000', employer_phone_source: 'https://example.com/jollibee-atc' }, NOW);
    expect((await lookupPhone(dir, 'Jollibee', 'Muntinlupa'))?.phone).toBe('(02) 8123-0000');

    writeFileSync(path.join(dir, 'lead-888-y.json'), JSON.stringify(lead({ psid: '888', banks: ['BDO'] })));
    const r = await finalizeLead(dir, tpl, 'lead-888-y.json', { ...details, first_name: 'Ana', company }, NOW);
    const d = JSON.parse(readFileSync(path.join(dir, r.folder, 'details.json'), 'utf8'));
    expect(d.data.employer_phone).toBe('(02) 8123-0000');
    expect(d.office_phone_source).toBe('https://example.com/jollibee-atc');
    expect(r.defaults.some((x) => /company directory/.test(x))).toBe(true);
    expect(r.missing).not.toContain('Office phone (not found)');

    // Another city: no number (branches differ), stays missing.
    writeFileSync(path.join(dir, 'lead-777-z.json'), JSON.stringify(lead({ psid: '777', banks: ['BDO'] })));
    const r2 = await finalizeLead(dir, tpl, 'lead-777-z.json', { ...details, first_name: 'Ben', company: { ...company, city: 'Cebu City' } }, NOW);
    expect(r2.missing).toContain('Office phone (not found)');
  });

  it('a number the owner types in the Default Form is kept for the next client', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ph2-'));
    const tpl = mkdtempSync(path.join(tmpdir(), 'tpl-'));
    writeFileSync(path.join(dir, 'lead-999-x.json'), JSON.stringify(lead({ banks: ['BDO'] })));
    const r = await finalizeLead(dir, tpl, 'lead-999-x.json', { ...details, company: { street: 'ATC', city: 'Muntinlupa' } }, NOW);
    const before = JSON.parse(readFileSync(path.join(dir, r.folder, 'details.json'), 'utf8'));
    await saveForm(dir, tpl, path.basename(r.folder), { ...before.form, employer_phone: '(02) 8777-1234' });
    expect(await lookupPhone(dir, 'Jollibee', 'Muntinlupa')).toMatchObject({ phone: '(02) 8777-1234', source: 'Entered by owner' });
    // Saving the same number again keeps the source it already has.
    await rememberPhone(dir, { company: 'Jollibee', city: 'Muntinlupa', phone: '(02) 8123-0000', source: 'https://example.com/x' });
    await saveForm(dir, tpl, path.basename(r.folder), { ...before.form, employer_phone: '(02) 8123-0000' });
    expect((await lookupPhone(dir, 'Jollibee', 'Muntinlupa'))?.source).toBe('https://example.com/x');
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
