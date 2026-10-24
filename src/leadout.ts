import { promises as fs } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { BANKS, buildApplication, settingsSchema, type Details, type Lead, type Settings } from './application.js';
import { fillBankPdf } from './pdf.js';

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
  const app = buildApplication(lead, details, now);
  const name = [details.first_name, details.last_name].filter(Boolean).join(' ');
  const folder = path.join(flowDir, 'applicants', folderName(lead.completed_at, name, lead.psid));
  await fs.mkdir(folder, { recursive: true });

  const pdfs: string[] = [];
  for (const bank of app.banks) {
    const tpl = path.join(templatesDir, `${bank}.pdf`);
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(tpl);
    } catch {
      app.missing.push(`${BANK_LABEL[bank]} PDF template not found`);
      continue;
    }
    const out = await fillBankPdf(bank, bytes, app, settings);
    const file = `${BANK_LABEL[bank]}.pdf`;
    await fs.writeFile(path.join(folder, file), out.bytes);
    pdfs.push(file);
  }
  for (const [i, photo] of (lead.id_photos ?? []).entries()) {
    const src = path.join(flowDir, photo);
    await fs.copyFile(src, path.join(folder, `ID-${i + 1}${path.extname(photo)}`)).catch(() => app.missing.push(`ID photo ${i + 1} file missing`));
  }
  const summary = {
    psid: lead.psid,
    completed_at: lead.completed_at,
    finalized_at: now.toISOString(),
    existing_cards: lead.banks,
    flags: lead.flags ?? [],
    banks_with_pdf: app.banks.map((b) => BANK_LABEL[b]),
    data: app.data,
    missing: app.missing,
    defaults: app.defaults,
    office_phone_source: details.employer_phone_source,
    printed: false,
  };
  await fs.writeFile(path.join(folder, 'details.json'), JSON.stringify(summary, null, 2), 'utf8');
  await fs.writeFile(
    path.join(folder, 'MISSING.txt'),
    `Missing / check before submitting:\n${app.missing.map((m) => `- ${m}`).join('\n')}\n\nDefaults (not from the applicant):\n${app.defaults.map((d) => `- ${d}`).join('\n')}\n`,
    'utf8',
  );
  let warning: string | undefined;
  try {
    await writeClientsXlsx(flowDir);
  } catch (err) {
    warning = err instanceof Error ? err.message : String(err);
  }
  return { folder: path.relative(flowDir, folder), pdfs, missing: app.missing, defaults: app.defaults, ...(warning ? { warning } : {}) };
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
    { header: 'Folder', key: 'folder', width: 34 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    // Text that starts like a formula is stored as plain text (CSV/Excel formula injection).
    const safe = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v]));
    ws.addRow({ ...safe, completed_at: r.completed_at.slice(0, 16).replace('T', ' '), printed: r.printed ? 'Yes' : 'No' });
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
