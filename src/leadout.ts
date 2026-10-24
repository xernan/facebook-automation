import { promises as fs } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { BANKS, buildApplication, formMissing, formSchema, formToData, settingsSchema, type AppForm, type BuiltApplication, type Details, type Lead, type Settings } from './application.js';
import { PDFDocument } from 'pdf-lib';
import { fillBankPdf } from './pdf.js';
import { printPdf } from './printer.js';
import { lookupPhone, OWNER_SOURCE, rememberPhone } from './phonebook.js';
import { applicationStats } from './stats.js';

// Finished applications on this computer only (personal data; never shown to the client):
//   <flowDir>/applicants/<YYYY-MM-DD> <Name>/  bank PDFs, ID photos, details.json, MISSING.txt
//   <flowDir>/CLIENTS.xlsx                     one row per applicant, rebuilt from the applicant folders

const BANK_LABEL = { metrobank: 'Metrobank', eastwest: 'EastWest', chinabank: 'China Bank' } as const;

export async function loadSettings(flowDir: string): Promise<Settings> {
  try {
    return settingsSchema.parse(JSON.parse(await fs.readFile(path.join(flowDir, 'settings.json'), 'utf8')));
  } catch (err: any) {
    if (err?.code === 'ENOENT') return settingsSchema.parse({});
    throw new Error('settings.json is invalid; fix it in the dashboard.');
  }
}

export async function saveSettings(flowDir: string, s: Settings): Promise<void> {
  await fs.mkdir(flowDir, { recursive: true });
  await fs.writeFile(path.join(flowDir, 'settings.json'), JSON.stringify(settingsSchema.parse(s), null, 2), 'utf8');
}

/** A folder name from the date and name, safe on Windows. */
export function folderName(date: string, name: string, psid: string): string {
  const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${date.slice(0, 10)} ${clean || `Applicant ${psid}`}`;
}

export interface Finalized {
  folder: string;
  pdfs: string[];
  missing: string[];
  defaults: string[];
  warning?: string;
}

export async function finalizeLead(
  flowDir: string,
  templatesDir: string,
  leadFile: string,
  details: Details,
  now = new Date(),
): Promise<Finalized> {
  const lead: Lead = JSON.parse(await fs.readFile(path.join(flowDir, leadFile), 'utf8'));
  const settings = await loadSettings(flowDir);
  // Office landline: a number found online goes into our directory; with none, use the directory's number
  // for the same company and branch city (only real numbers are ever in it).
  const employer = lead.answers.employer_name;
  let phoneSource = details.employer_phone_source as string | undefined;
  let fromBook = false;
  if (details.employer_phone && phoneSource && employer && details.company?.city) {
    await rememberPhone(flowDir, { company: employer, city: details.company.city, phone: details.employer_phone, source: phoneSource }, now).catch(() => undefined);
  } else if (!details.employer_phone) {
    const hit = await lookupPhone(flowDir, employer, details.company?.city).catch(() => undefined);
    if (hit) {
      details = { ...details, employer_phone: hit.phone };
      phoneSource = hit.source;
      fromBook = true;
    }
  }
  const app = buildApplication(lead, details, now);
  if (fromBook) app.defaults.push(`Office phone from our company directory (source: ${phoneSource})`);
  const name = [details.first_name, details.last_name].filter(Boolean).join(' ');
  const folder = path.join(flowDir, 'applicants', folderName(lead.completed_at, name, lead.psid));
  await fs.mkdir(folder, { recursive: true });

  const pdfs = await writeBankPdfs(folder, templatesDir, app.banks, app, settings, app.missing);
  // ID photos: copies, plus one printable PDF with every photo (one per page, fitted with a margin).
  const idPdf = await PDFDocument.create();
  for (const [i, photo] of (lead.id_photos ?? []).entries()) {
    const src = path.join(flowDir, photo);
    try {
      const bytes = await fs.readFile(src);
      await fs.writeFile(path.join(folder, `ID-${i + 1}${path.extname(photo)}`), bytes);
      const ext = path.extname(photo).toLowerCase();
      const img = ext === '.png' ? await idPdf.embedPng(bytes) : ext === '.jpg' || ext === '.jpeg' ? await idPdf.embedJpg(bytes) : undefined;
      if (!img) {
        app.missing.push(`ID photo ${i + 1} is not JPG/PNG: print it from the folder`);
        continue;
      }
      const page = idPdf.addPage([612, 792]);
      const scale = Math.min(540 / img.width, 720 / img.height, 1.5);
      page.drawImage(img, { x: (612 - img.width * scale) / 2, y: 792 - 36 - img.height * scale, width: img.width * scale, height: img.height * scale });
    } catch {
      app.missing.push(`ID photo ${i + 1} file missing`);
    }
  }
  if (idPdf.getPageCount() > 0) {
    await fs.writeFile(path.join(folder, 'ID photos.pdf'), await idPdf.save());
    pdfs.push('ID photos.pdf');
  }
  const summary = {
    psid: lead.psid,
    completed_at: lead.completed_at,
    finalized_at: now.toISOString(),
    existing_cards: lead.banks,
    flags: lead.flags ?? [],
    banks_with_pdf: app.banks.map((b) => BANK_LABEL[b]),
    banks: app.banks,
    form: app.form,
    bank_only: app.bankOnly,
    data: app.data,
    missing: app.missing,
    defaults: app.defaults,
    office_phone_source: phoneSource,
    printed: false,
  };
  await fs.writeFile(path.join(folder, 'details.json'), JSON.stringify(summary, null, 2), 'utf8');
  await fs.writeFile(path.join(folder, 'MISSING.txt'), missingText(app.missing, app.defaults), 'utf8');
  let warning: string | undefined;
  try {
    await writeClientsXlsx(flowDir);
  } catch (err) {
    warning = err instanceof Error ? err.message : String(err);
  }
  // Auto-print (owner setting): bank forms first, then the ID sheet. The PC must be on.
  if (settings.auto_print && settings.printer && pdfs.length > 0) {
    try {
      for (const f of [...pdfs].sort((a, b) => Number(a.startsWith('ID')) - Number(b.startsWith('ID')))) {
        await printPdf(path.join(folder, f), settings.printer);
        await new Promise((r) => setTimeout(r, 4000));
      }
      summary.printed = true;
      await fs.writeFile(path.join(folder, 'details.json'), JSON.stringify({ ...summary, printed_at: new Date().toISOString() }, null, 2), 'utf8');
      await writeClientsXlsx(flowDir).catch(() => undefined);
    } catch (err) {
      warning = `Auto-print failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { folder: path.relative(flowDir, folder), pdfs, missing: app.missing, defaults: app.defaults, ...(warning ? { warning } : {}) };
}

function missingText(missing: string[], defaults: string[]): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');
  return `Missing / check before submitting:\n${list(missing)}\n\nDefaults (not from the applicant):\n${list(defaults)}\n`;
}

/** Fills one PDF per bank from the built data. Missing templates are added to `missing`. */
async function writeBankPdfs(
  folder: string,
  templatesDir: string,
  banks: BuiltApplication['banks'],
  app: Pick<BuiltApplication, 'banks' | 'data' | 'bankOnly' | 'missing' | 'defaults'>,
  settings: Settings,
  missing: string[],
): Promise<string[]> {
  const pdfs: string[] = [];
  for (const bank of banks) {
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(path.join(templatesDir, `${bank}.pdf`));
    } catch {
      missing.push(`${BANK_LABEL[bank]} PDF template not found`);
      continue;
    }
    const out = await fillBankPdf(bank, bytes, { ...app, form: {} } as BuiltApplication, settings);
    const file = `${BANK_LABEL[bank]}.pdf`;
    await fs.writeFile(path.join(folder, file), out.bytes);
    pdfs.push(file);
  }
  return pdfs;
}

/**
 * The owner edited the Default Form in the dashboard: save it, recheck what is missing and make the bank PDFs
 * again. Bank choice, defaults and ID-based boxes stay as they were.
 */
export async function saveForm(flowDir: string, templatesDir: string, folderName: string, form: AppForm): Promise<{ missing: string[]; pdfs: string[] }> {
  const dir = path.join(flowDir, 'applicants', folderName);
  const file = path.join(dir, 'details.json');
  const d = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!d.banks || !d.bank_only) throw new Error('This applicant was saved before the form existed; finalize it again.');
  const clean = formSchema.parse(form);
  const data = formToData(clean);
  const missing = formMissing(clean);
  const settings = await loadSettings(flowDir);
  // Office zip follows the form for the bank-only zip boxes.
  const bankOnly = structuredClone(d.bank_only);
  for (const b of Object.keys(bankOnly)) {
    if (clean.company?.zip) bankOnly[b].business_zip_code = clean.company.zip;
    else delete bankOnly[b].business_zip_code;
  }
  // A number the owner typed (or changed) goes into our directory for the next client from that branch.
  if (clean.employer_phone && clean.employer && clean.company?.city) {
    const known = await lookupPhone(flowDir, clean.employer, clean.company.city).catch(() => undefined);
    if (known?.phone !== clean.employer_phone) {
      await rememberPhone(flowDir, { company: clean.employer, city: clean.company.city, phone: clean.employer_phone, source: OWNER_SOURCE }).catch(() => undefined);
    }
  }
  const pdfs = await writeBankPdfs(dir, templatesDir, d.banks, { banks: d.banks, data, bankOnly, missing, defaults: d.defaults ?? [] }, settings, missing);
  const next = { ...d, form: clean, data, bank_only: bankOnly, missing, edited_at: new Date().toISOString(), printed: false };
  await fs.writeFile(file, JSON.stringify(next, null, 2), 'utf8');
  await fs.writeFile(path.join(dir, 'MISSING.txt'), missingText(missing, d.defaults ?? []), 'utf8');
  await writeClientsXlsx(flowDir).catch(() => undefined);
  return { missing, pdfs };
}

export interface ApplicantRow {
  folder: string;
  completed_at: string;
  name: string;
  mobile: string;
  email: string;
  existing_cards: string;
  banks_with_pdf: string;
  flags: string;
  missing: string;
  printed: boolean;
  /** Bank result the owner set in the dashboard (Pending until then). */
  result: string;
  approved_card: string;
  /** Client said OK to a proof post (first-name initial only). */
  proof_ok: boolean;
}

export async function listApplicants(flowDir: string): Promise<ApplicantRow[]> {
  const root = path.join(flowDir, 'applicants');
  const names = await fs.readdir(root).catch(() => [] as string[]);
  const rows: ApplicantRow[] = [];
  for (const n of names) {
    try {
      const d = JSON.parse(await fs.readFile(path.join(root, n, 'details.json'), 'utf8'));
      rows.push({
        folder: n,
        completed_at: d.completed_at,
        name: d.data.full_name ?? '',
        mobile: d.data.mobile ?? '',
        email: d.data.email ?? '',
        existing_cards: (d.existing_cards ?? []).join(', '),
        banks_with_pdf: (d.banks_with_pdf ?? []).join(', '),
        flags: (d.flags ?? []).join(', '),
        missing: (d.missing ?? []).join('; '),
        printed: !!d.printed,
        result: d.outcome?.result ?? 'Pending',
        approved_card: d.outcome?.card ?? '',
        proof_ok: !!d.outcome?.proof_ok,
      });
    } catch {
      // A folder without details.json is not an applicant.
    }
  }
  return rows.sort((a, b) => b.completed_at.localeCompare(a.completed_at));
}

/** Rebuilds CLIENTS.xlsx from the applicant folders (so it never drifts from them). */
export async function writeClientsXlsx(flowDir: string): Promise<void> {
  const rows = await listApplicants(flowDir);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Clients');
  ws.columns = [
    { header: 'Completed', key: 'completed_at', width: 20 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Mobile', key: 'mobile', width: 16 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Has cards', key: 'existing_cards', width: 22 },
    { header: 'PDFs made', key: 'banks_with_pdf', width: 28 },
    { header: 'Flags', key: 'flags', width: 20 },
    { header: 'Missing / check', key: 'missing', width: 60 },
    { header: 'Printed', key: 'printed', width: 9 },
    { header: 'Bank result', key: 'result', width: 12 },
    { header: 'Approved card', key: 'approved_card', width: 26 },
    { header: 'Proof post OK', key: 'proof_ok', width: 13 },
    { header: 'Folder', key: 'folder', width: 34 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    // Text that starts like a formula is stored as plain text (CSV/Excel formula injection).
    const safe = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v]));
    ws.addRow({ ...safe, completed_at: r.completed_at.slice(0, 16).replace('T', ' '), printed: r.printed ? 'Yes' : 'No', proof_ok: r.proof_ok ? 'Yes' : 'No' });
  }
  // Weekly totals against the quota, newest first (same numbers as the dashboard).
  const settings = await loadSettings(flowDir).catch(() => settingsSchema.parse({}));
  const st = applicationStats(rows, { quota: settings.weekly_quota, startDay: settings.week_start_day });
  const wk = wb.addWorksheet('Weekly');
  wk.columns = [
    { header: 'Month', key: 'month', width: 10 },
    { header: 'Week', key: 'week', width: 26 },
    { header: 'Complete', key: 'complete', width: 10 },
    { header: 'Quota', key: 'quota', width: 8 },
    { header: 'Reached', key: 'reached', width: 9 },
    { header: 'Ready (nothing to check)', key: 'ready', width: 24 },
    { header: 'Printed', key: 'printed', width: 9 },
  ];
  wk.getRow(1).font = { bold: true };
  for (const m of [st.current_month, ...st.archive]) {
    for (const w of m.weeks) {
      wk.addRow({ month: m.month, week: `${w.start} to ${w.end}`, complete: w.complete, quota: w.quota, reached: w.reached ? 'Yes' : 'No', ready: w.ready, printed: w.printed });
    }
    wk.addRow({ month: m.month, week: 'Month total', complete: m.complete, ready: m.ready, printed: m.printed }).font = { bold: true };
  }
  const tmp = path.join(flowDir, `CLIENTS.${process.pid}.tmp.xlsx`);
  await wb.xlsx.writeFile(tmp);
  await fs.rename(tmp, path.join(flowDir, 'CLIENTS.xlsx')).catch(async (err) => {
    await fs.rm(tmp, { force: true });
    // Excel keeps the file locked while it is open; the folders stay the source of truth.
    if (err?.code === 'EPERM' || err?.code === 'EBUSY') throw new Error('CLIENTS.xlsx is open in Excel. Close it; it will update next time.');
    throw err;
  });
}

export { BANKS };
