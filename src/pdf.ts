import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import { PDFArray, PDFCheckBox, TextAlignment, PDFDict, PDFDocument, PDFDropdown, PDFName, PDFRadioGroup, PDFRef, PDFTextField, type PDFFont, type PDFPage } from 'pdf-lib';
import { cardName, DECLARE_NO, type BankKey, type BuiltApplication, type Settings } from './application.js';

// Fills a bank's PDF template. Box names say what goes in them (same naming as the card app's templates):
//   <key>                         text, e.g. mother_maiden_name
//   <key>__checkbox__<option>     ticked when the value is that option, e.g. civil_status__checkbox__married
//   <key>__fmt_<mm|dd|yyyy|mmyy>  part of a YYYY-MM-DD date
//   <key>__dig_<a>_<b>            digits a..b of a number (EastWest mobile boxes)
//   bank_only__<stem>             bank-specific box (owner defaults / settings)
//   admin_only__agent_code        from settings
//   signature__...                left blank: the client signs the printed form
// A trailing __<n> marks a second copy of the same box.

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function formatPdfDate(value: string, format?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  switch (format) {
    case 'mmyy':
      return `${mo}/${y.slice(2)}`;
    case 'mm':
      return mo;
    case 'dd':
      return d;
    case 'yyyy':
      return y;
    default:
      return `${mo}/${d}/${y}`;
  }
}

/** Digits start..end of a PH mobile written as 09XXXXXXXXX. */
export function pdfDigits(value: string, start: number, end: number): string {
  let digits = value.replace(/\D/g, '');
  if (/^639\d{9}$/.test(digits)) digits = `0${digits.slice(2)}`;
  else if (/^9\d{9}$/.test(digits)) digits = `0${digits}`;
  return digits.slice(start, end);
}

/** One character per box: numbers drop separators when they do not fit; then cut to the boxes. */
export function combText(text: string, boxes: number): string {
  let v = text;
  if (v.length <= boxes) return v;
  if (/^[\d\s\-/.()]+$/.test(v)) v = v.replace(/[\s\-/.()]/g, '');
  return v.slice(0, boxes);
}

const DATE_KEYS = new Set(['birthday', 'date_hired']);

/**
 * Boxes whose template position needs a fix (checked on the real template): `raise` points up, `center` the text.
 * Metrobank's printed name touched the "SIGNATURE OF APPLICANT OVER PRINTED NAME" label under it.
 */
export const BOX_FIX: Partial<Record<BankKey, Record<string, { raise?: number; center?: boolean }>>> = {
  metrobank: { full_name: { raise: 3, center: true } },
};

/**
 * Email domain boxes printed on the template (no form field): the domain is ticked and only the part before the @ is
 * written, so it is not printed twice. Centers in PDF points, checked on the real template (owner, 2026-10-25).
 */
const EMAIL_DOMAIN_BOX: Partial<Record<BankKey, Record<string, [number, number]>>> = {
  metrobank: { 'gmail.com': [477, 751], 'yahoo.com': [525.6, 751] },
};

/**
 * Bank-only check boxes printed on the template with no form field: [x, y center, size] on page 1, checked on the
 * real template. Ticked when the bank-only value is true.
 */
const PRINTED_BOX: Partial<Record<BankKey, Record<string, [number, number, number]>>> = {
  chinabank: { 'education__checkbox__college': [198.1, 719, 0.75] },
};

/** Draws a check mark centered on (x, y); size 1 fits a ~8 pt box. */
function drawTick(page: PDFPage, x: number, y: number, size = 1) {
  const k = size;
  page.drawLine({ start: { x: x - 3 * k, y }, end: { x: x - 1 * k, y: y - 2.5 * k }, thickness: 1.4 * k });
  page.drawLine({ start: { x: x - 1 * k, y: y - 2.5 * k }, end: { x: x + 3.5 * k, y: y + 3.5 * k }, thickness: 1.4 * k });
}

/** Bank-only boxes that take a value from the Default Form (so dashboard edits reach them). */
const FROM_FORM = new Set(['business_unit_floor_building']);

/** One box with YEARS and MONTHS columns: years in the left half, months in the right (checked on the real template). */
const YEARS_MONTHS: Partial<Record<BankKey, Record<string, string>>> = { metrobank: { length_of_service: 'length_of_service_months' } };

/** Boxes a bank prints as First / Middle / Last columns (checked on the real template). */
const NAME_COLUMNS: Partial<Record<BankKey, string[]>> = { eastwest: ['mother_maiden_name', 'spouse_name'] };

// Answers print in a narrow, thick letter (Archivo Narrow, SIL Open Font License: fonts/OFL.txt) so they are easy
// to read on paper and long names/addresses still fit their boxes.
const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fonts');
const fontCache = new Map<string, Uint8Array>();
function fontBytes(bold: boolean): Uint8Array {
  const file = bold ? 'ArchivoNarrow-Bold.ttf' : 'ArchivoNarrow-Regular.ttf';
  if (!fontCache.has(file)) fontCache.set(file, readFileSync(path.join(FONT_DIR, file)));
  return fontCache.get(file)!;
}

const MIN_SIZE = 4;
/** Owner rule: every answer must be readable on paper. No answer prints smaller than this (pt). */
export const READABLE_SIZE = 8;
/** One long answer must not shrink its row: the others on the line stay at least this big (pt). */
const ROW_KEEP_SIZE = 10;
/** As large as the box allows (95% of its height, text fits its width), up to `largest`. */
export function fitFontSize(font: PDFFont, text: string, box: { width: number; height: number }, cells: number, largest: number): number {
  const room = cells ? box.width / cells - 1 : box.width - 4;
  const textWidth = cells ? Math.max(...[...text].map((ch) => font.widthOfTextAtSize(ch, 1))) : font.widthOfTextAtSize(text, 1);
  const size = Math.min(largest, box.height * 0.95, textWidth > 0 ? room / textWidth : largest);
  return Math.max(MIN_SIZE, Math.floor(size * 2) / 2);
}

export async function fillBankPdf(
  bank: BankKey,
  template: Uint8Array,
  app: BuiltApplication,
  settings: Settings,
): Promise<{ bytes: Uint8Array; filled: number }> {
  const pdf = await PDFDocument.load(template);
  const form = pdf.getForm();
  const choice = settings.card_choice[bank];
  const bankOnly: Record<string, string | true> = { ...app.bankOnly[bank] };
  if (choice) bankOnly[`card_choice__checkbox__${choice}`] = true;
  if (choice && bank === 'chinabank') bankOnly[`card_variant__checkbox__${choice}`] = true;
  let filled = 0;
  for (const [stem, [x, y, size]] of Object.entries(PRINTED_BOX[bank] ?? {})) {
    if (bankOnly[stem] === true) {
      drawTick(pdf.getPages()[0]!, x, y, size);
      filled++;
    }
  }

  for (const field of form.getFields()) {
    const name = field.getName().replace(/__\d+$/, '');
    if (name.startsWith('signature__')) {
      form.removeField(field);
      continue;
    }
    try {
      if (name.startsWith('admin_only__')) {
        if (name === 'admin_only__agent_code' && settings.agent_code && field instanceof PDFTextField) {
          field.setText(settings.agent_code);
          filled++;
        }
        continue;
      }
      if (name.startsWith('bank_only__')) {
        const stem = name.slice('bank_only__'.length);
        const v = bankOnly[stem] ?? (FROM_FORM.has(stem) ? app.data[stem] : undefined);
        if ((v === true || (v === undefined && DECLARE_NO.test(stem))) && field instanceof PDFCheckBox) {
          field.check();
          filled++;
        } else if (typeof v === 'string' && field instanceof PDFTextField) {
          field.setText(v);
          filled++;
        }
        continue;
      }

      const m = /^([a-z0-9_]+?)(?:__checkbox__([a-z0-9]+)|__fmt_([a-z]+)|__dig_(\d+)_(\d+))?$/.exec(name);
      if (!m) continue;
      const [, key, option, fmt, d1, d2] = m;
      const value = key === 'agent_name' ? settings.agent_name : app.data[key!];
      if (!value) continue;

      if (field instanceof PDFCheckBox) {
        if (option && norm(value) === option) {
          field.check();
          filled++;
        }
      } else if (field instanceof PDFDropdown || field instanceof PDFRadioGroup) {
        const opt = field.getOptions().find((o) => norm(o) === norm(value));
        if (opt) {
          field.select(opt);
          filled++;
        }
      } else if (field instanceof PDFTextField) {
        let t = fmt ? formatPdfDate(value, fmt) : d1 ? pdfDigits(value, Number(d1), Number(d2)) : DATE_KEYS.has(key!) ? formatPdfDate(value) : value;
        t = t.replace(/[\r\n\t]+/g, ' ').trim();
        if (!t) continue;
        const max = field.getMaxLength();
        // Name on card over the bank's boxes: shorten it the owner's way (never just cut a name in half).
        if (key === 'name_on_card' && max && t.length > max) t = cardName(app.data.first_name, app.data.middle_name, app.data.last_name, max) || t;
        const domainBox = key === 'email' ? EMAIL_DOMAIN_BOX[bank] : undefined;
        const at = domainBox && /^([^@\s]+)@([^@\s]+)$/.exec(t);
        const box = at && domainBox[at[2]!.toLowerCase()];
        if (at && box) {
          const widget = field.acroField.getWidgets()[0]!;
          drawTick(pdf.getPages().find((pg) => pg.ref === widget.P()) ?? pdf.getPages()[0]!, box[0], box[1]);
          t = at[1]!;
        }
        if (max && field.isCombed()) t = combText(t, max);
        else if (max && t.length > max) {
          // With one uniform size the text is drawn on the page, so a long address is never cut: lift the box limit.
          if (settings.text_uniform_size) field.setMaxLength(undefined);
          else t = t.slice(0, max);
        }
        field.setText(t);
        filled++;
      }
    } catch {
      // A box the template cannot take (font, size) stays blank; the rest still fill.
    }
  }
  // Style every filled answer in the narrow bold font.
  //  - uniform size (text_uniform_size): every answer the same size, drawn on the page sitting on its box's line;
  //    it only shrinks when it would run past the box's width. May rise above a short box.
  //  - otherwise: as big as each box allows, up to text_max_size.
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes(settings.text_bold), { subset: true });
  const pages = pdf.getPages();
  const plans: Plan[] = [];
  for (const field of form.getFields()) {
    if (!(field instanceof PDFTextField)) continue;
    const t = field.getText();
    if (!t) continue;
    try {
      const widget = field.acroField.getWidgets()[0]!;
      const fix = BOX_FIX[bank]?.[field.getName().replace(/__\d+$/, '')];
      if (fix?.raise) widget.setRectangle({ ...widget.getRectangle(), y: widget.getRectangle().y + fix.raise });
      if (fix?.center) field.setAlignment(TextAlignment.Center);
      const rect = widget.getRectangle();
      const cells = field.isCombed() ? (field.getMaxLength() ?? 0) : 0;
      const page = pages.find((pg) => pg.ref === widget.P()) ?? pages[0]!;
      const key = field.getName().replace(/__\d+$/, '');
      const monthsKey = YEARS_MONTHS[bank]?.[key];
      if (monthsKey) {
        const half = rect.width / 2;
        const largest = settings.text_uniform_size || settings.text_max_size;
        [t, app.data[monthsKey]].forEach((part, i) => {
          if (!part) return;
          const size = Math.min(largest, fitFontSize(font, part, { width: half, height: settings.text_uniform_size ? 1e6 : rect.height }, 0, 1e6));
          const y = rect.y + Math.max(0.8, (rect.height - size * 0.72) / 2);
          page.drawText(part, { x: rect.x + i * half + (half - font.widthOfTextAtSize(part, size)) / 2, y, size, font });
        });
        form.removeField(field);
        continue;
      }
      if (NAME_COLUMNS[bank]?.includes(key) && app.data[`${key}_first`]) {
        // One name part centered in each third of the box, under its First / Middle / Last label.
        const third = rect.width / 3;
        const parts = [app.data[`${key}_first`], app.data[`${key}_middle`], app.data[`${key}_last`]];
        const largest = settings.text_uniform_size || settings.text_max_size;
        parts.forEach((part, i) => {
          if (!part) return;
          const size = Math.min(largest, fitFontSize(font, part, { width: third, height: settings.text_uniform_size ? 1e6 : rect.height }, 0, 1e6));
          const y = rect.y + Math.max(0.8, (rect.height - size * 0.72) / 2);
          page.drawText(part, { x: rect.x + i * third + (third - font.widthOfTextAtSize(part, size)) / 2, y, size, font });
        });
        form.removeField(field);
        continue;
      }
      if (settings.text_uniform_size) {
        plans.push({ ...planUniform(font, t, rect, cells, page, settings.text_uniform_size), center: fix?.center });
        form.removeField(field);
      } else {
        field.setFontSize(fitFontSize(font, t, rect, cells, settings.text_max_size));
        field.updateAppearances(font);
      }
    } catch {
      // Keeps the template's own look for a box that cannot be restyled.
    }
  }

  drawPlans(font, keepInRoom(font, sameSizePerLine(plans)));

  // Flatten: answers become part of the page, so every viewer and printer shows them (some print form boxes blank).
  if (settings.flatten) form.flatten();
  dropDeadAnnotations(pdf);
  return { bytes: await pdf.save(), filled };
}

interface Plan {
  page: PDFPage;
  rect: { x: number; y: number; width: number; height: number };
  lines: string[];
  cells: number;
  size: number;
  center?: boolean;
}

/** Split text into two lines at the space nearest the middle. */
export function twoLines(text: string): [string, string] | undefined {
  const spaces = [...text.matchAll(/ /g)].map((m) => m.index!);
  if (spaces.length === 0) return undefined;
  const mid = text.length / 2;
  const at = spaces.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a));
  return [text.slice(0, at), text.slice(at + 1)];
}

/**
 * Uniform size, shrinking only to fit the box width. A long answer in a tall box (≥ 12pt) uses two lines when
 * that lets it print larger than squeezing it onto one line.
 */
function planUniform(font: PDFFont, text: string, rect: Plan['rect'], cells: number, page: PDFPage, uniform: number): Plan {
  const fit = (t: string) => Math.min(uniform, fitFontSize(font, t, { width: rect.width, height: 1e6 }, cells, 1e6));
  // Too long for a small box: drop a note in brackets before making it hard to read.
  if (!cells && fit(text) < READABLE_SIZE) {
    const short = text.replace(/\s*\([^)]*\)/g, '').trim();
    if (short) text = short;
  }
  const one = fit(text);
  if (!cells && one < uniform && rect.height >= 12) {
    const split = twoLines(text);
    if (split) {
      const two = Math.min(uniform, Math.max(rect.height / 2.25, READABLE_SIZE), ...split.map((l) => fitFontSize(font, l, { width: rect.width, height: 1e6 }, 0, 1e6)));
      if (two > one) return { page, rect, lines: split, cells, size: Math.floor(two * 2) / 2 };
    }
  }
  return { page, rect, lines: [text], cells, size: cells ? one : Math.max(one, READABLE_SIZE) };
}

/**
 * Answers that share a printed line (same page and baseline) use the same size: the smallest any of them needs,
 * unless that is small. Then a long answer keeps its own size and the others stay at ROW_KEEP_SIZE or more.
 */
export function sameSizePerLine<T extends { page: unknown; rect: { y: number }; cells: number; size: number }>(plans: T[]): T[] {
  const sizes = new Map<T, number>();
  for (const p of plans) {
    if (p.cells) continue;
    const row = plans.filter((q) => !q.cells && q.page === p.page && Math.abs(q.rect.y - p.rect.y) < 1.5);
    sizes.set(p, Math.min(p.size, Math.max(Math.min(...row.map((q) => q.size)), ROW_KEEP_SIZE)));
  }
  for (const [p, size] of sizes) p.size = size;
  return plans;
}

/**
 * An answer kept at the readable size may run past its small box, but never over the next answer or off the page:
 * then it wraps to two lines, or as a last resort shrinks to the room there is.
 */
function keepInRoom(font: PDFFont, plans: Plan[]): Plan[] {
  for (const p of plans) {
    if (p.cells || p.lines.length !== 1) continue;
    const next = plans.filter((q) => q.page === p.page && q.rect.x > p.rect.x && Math.abs(q.rect.y - p.rect.y) < 6).map((q) => q.rect.x - 3);
    const room = Math.min(p.page.getWidth() - 12, ...next) - p.rect.x - 1.5;
    const text = p.lines[0]!;
    if (font.widthOfTextAtSize(text, p.size) <= room) continue;
    const fit = (t: string) => Math.floor((room / font.widthOfTextAtSize(t, 1)) * 2) / 2;
    const split = twoLines(text);
    const two = split ? Math.min(p.size, ...split.map(fit)) : 0;
    if (split && two >= fit(text)) {
      p.lines = split;
      p.size = two;
    } else p.size = Math.max(MIN_SIZE, fit(text));
  }
  return plans;
}

function drawPlans(font: PDFFont, plans: Plan[]) {
  for (const { page, rect, lines, cells, size, center } of plans) {
    if (cells) {
      const y = rect.y + Math.max(0.8, (rect.height - size * 0.72) / 2);
      const cell = rect.width / cells;
      [...lines[0]!].forEach((ch, i) => page.drawText(ch, { x: rect.x + i * cell + (cell - font.widthOfTextAtSize(ch, size)) / 2, y, size, font }));
    } else if (lines.length === 2) {
      page.drawText(lines[0]!, { x: rect.x + 1.5, y: Math.max(rect.y + rect.height / 2 + 0.8, rect.y + 1.2 + size * 0.95), size, font });
      page.drawText(lines[1]!, { x: rect.x + 1.5, y: rect.y + 1.2, size, font });
    } else {
      const x = center ? rect.x + (rect.width - font.widthOfTextAtSize(lines[0]!, size)) / 2 : rect.x + 1.5;
      page.drawText(lines[0]!, { x, y: rect.y + Math.max(0.8, (rect.height - size * 0.72) / 2), size, font });
    }
  }
}

/**
 * Removing or flattening form boxes can leave each page's annotation list pointing at widgets that no longer
 * exist. Viewers skip them, but Adobe Acrobat refuses to print the file. Keep only annotations that still exist
 * and are not form widgets of removed boxes.
 */
export function dropDeadAnnotations(pdf: PDFDocument): number {
  const live = new Set(pdf.getForm().getFields().flatMap((f) => f.acroField.getWidgets().map((w) => w.dict)));
  let dropped = 0;
  for (const page of pdf.getPages()) {
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    const keep = PDFArray.withContext(pdf.context);
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = raw instanceof PDFRef ? pdf.context.lookup(raw) : raw;
      const isWidget = dict instanceof PDFDict && dict.lookup(PDFName.of('Subtype')) === PDFName.of('Widget');
      if (!(dict instanceof PDFDict) || (isWidget && !live.has(dict))) {
        dropped++;
        continue;
      }
      keep.push(raw);
    }
    if (keep.size() === 0) page.node.delete(PDFName.of('Annots'));
    else page.node.set(PDFName.of('Annots'), keep);
  }
  return dropped;
}
