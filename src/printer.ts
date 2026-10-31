import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

// Silent printing on Windows through Adobe Acrobat ("/t <file> <printer>"), the only PDF program on the owner's PC
// that prints without a dialog. Verified on the owner's Canon G1010 (2026-10-24).

const ACROBAT_PATHS = [
  'C:\\Program Files\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe',
  'C:\\Program Files (x86)\\Adobe\\Acrobat Reader DC\\Reader\\AcroRd32.exe',
  'C:\\Program Files\\Adobe\\Acrobat Reader DC\\Reader\\AcroRd32.exe',
];

export function findAcrobat(configured?: string): string | undefined {
  if (configured) return existsSync(configured) ? configured : undefined;
  return ACROBAT_PATHS.find((p) => existsSync(p));
}

const run = (file: string, args: string[], timeoutMs: number) =>
  new Promise<string>((resolve, reject) =>
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );

/** Printer names installed on this PC. */
export async function listPrinters(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const out = await run('powershell.exe', ['-NoProfile', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name'], 15000);
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Sends one PDF to the printer. Acrobat stays open in the background; that is normal. */
export async function printPdf(file: string, printer: string, acrobatPath?: string): Promise<void> {
  const acrobat = findAcrobat(acrobatPath);
  if (!acrobat) throw new Error('Adobe Acrobat was not found on this PC, so it cannot print by itself.');
  if (!printer) throw new Error('Choose a printer in Settings first.');
  // Acrobat /t does not exit until it is closed, so start it and do not wait for it.
  const { spawn } = await import('node:child_process');
  const child = spawn(acrobat, ['/t', file, printer], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}
