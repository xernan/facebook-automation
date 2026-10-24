import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import { PDFCheckBox, PDFDocument, PDFDropdown, PDFRadioGroup, PDFTextField, type PDFFont } from 'pdf-lib';
import type { BankKey, BuiltApplication, Settings } from './application.js';

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
        const v = bankOnly[stem];
        if (v === true && field instanceof PDFCheckBox) {
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
        if (max && field.isCombed()) t = combText(t, max);
        else if (max && t.length > max) t = t.slice(0, max);
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
  for (const field of form.getFields()) {
    if (!(field instanceof PDFTextField)) continue;
    const t = field.getText();
    if (!t) continue;
    try {
      const widget = field.acroField.getWidgets()[0]!;
      const rect = widget.getRectangle();
      const cells = field.isCombed() ? (field.getMaxLength() ?? 0) : 0;
      const page = pages.find((pg) => pg.ref === widget.P()) ?? pages[0]!;
      const key = field.getName().replace(/__\d+$/, '');
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
        const size = Math.min(settings.text_uniform_size, fitFontSize(font, t, { width: rect.width, height: 1e6 }, cells, 1e6));
        const y = rect.y + Math.max(0.8, (rect.height - size * 0.72) / 2);
        if (cells) {
          const cell = rect.width / cells;
          [...t].forEach((ch, i) => page.drawText(ch, { x: rect.x + i * cell + (cell - font.widthOfTextAtSize(ch, size)) / 2, y, size, font }));
        } else {
          page.drawText(t, { x: rect.x + 1.5, y, size, font });
        }
        form.removeField(field);
      } else {
        field.setFontSize(fitFontSize(font, t, rect, cells, settings.text_max_size));
        field.updateAppearances(font);
      }
    } catch {
      // Keeps the template's own look for a box that cannot be restyled.
    }
  }

  // Flatten: answers become part of the page, so every viewer and printer shows them (some print form boxes blank).
  if (settings.flatten) form.flatten();
  return { bytes: await pdf.save(), filled };
}
