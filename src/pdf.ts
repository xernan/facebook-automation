import { PDFCheckBox, PDFDocument, PDFDropdown, PDFRadioGroup, PDFTextField } from 'pdf-lib';
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
  return { bytes: await pdf.save(), filled };
}
