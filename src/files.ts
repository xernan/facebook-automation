import { promises as fs } from 'node:fs';
import path from 'node:path';

export const IMAGE_EXTENSIONS: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

/**
 * Resolves a file the caller wants to upload. Only files inside mediaDir are allowed,
 * so a prompt cannot make the server upload arbitrary files from disk.
 */
export async function resolveMediaFile(mediaDir: string, requested: string, maxBytes: number) {
  const ext = path.extname(requested).toLowerCase();
  const mime = IMAGE_EXTENSIONS[ext];
  if (!mime) throw new Error(`Unsupported image type "${ext}". Allowed: ${Object.keys(IMAGE_EXTENSIONS).join(', ')}`);

  let root: string;
  let full: string;
  try {
    root = await fs.realpath(mediaDir);
    full = await fs.realpath(path.resolve(root, requested));
  } catch {
    throw new Error(`File not found in the media folder: ${requested}`);
  }
  const rel = path.relative(root, full);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Only files inside the media folder can be uploaded.');
  }
  const stat = await fs.stat(full);
  if (!stat.isFile()) throw new Error('Not a file.');
  if (stat.size > maxBytes) throw new Error(`File is larger than ${Math.round(maxBytes / 1048576)} MB.`);
  return { full, mime, name: path.basename(full) };
}

/** CSV cell with quoting and spreadsheet formula-injection guard. */
export function csvCell(value: unknown): string {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface Lead {
  id: string;
  created_time?: string;
  ad_id?: string;
  form_id?: string;
  field_data?: { name: string; values?: string[] }[];
}

export function leadsToCsv(leads: Lead[]): string {
  const fieldNames: string[] = [];
  for (const l of leads) for (const f of l.field_data ?? []) if (!fieldNames.includes(f.name)) fieldNames.push(f.name);
  const header = ['lead_id', 'created_time', 'form_id', 'ad_id', ...fieldNames];
  const rows = leads.map((l) => {
    const byName = new Map((l.field_data ?? []).map((f) => [f.name, (f.values ?? []).join('; ')]));
    return [l.id, l.created_time, l.form_id, l.ad_id, ...fieldNames.map((n) => byName.get(n))];
  });
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export async function writeExport(exportDir: string, baseName: string, content: string): Promise<string> {
  await fs.mkdir(exportDir, { recursive: true });
  const safe = baseName.replace(/[^A-Za-z0-9_-]/g, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(exportDir, `${safe}_${stamp}.csv`);
  await fs.writeFile(file, '﻿' + content, 'utf8');
  return file;
}

/**
 * Replaces `dest` with `tmp` (the last step of an atomic save). On Windows a virus scanner, the search indexer or
 * OneDrive can hold the just-written file for a moment and rename fails with EPERM/EBUSY/EACCES; retry briefly.
 */
export async function replaceFile(tmp: string, dest: string, rename = fs.rename, tries = 8): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      return await rename(tmp, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * i));
    }
  }
}
