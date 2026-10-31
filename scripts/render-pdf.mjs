// QA helper: renders PDF pages to PNG so layout can be checked by eye.
// node scripts/render-pdf.mjs <file.pdf> <outPrefix> [scale=2] [pages=all]
import { readFileSync, writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const [file, prefix, scale = '2', pages] = process.argv.slice(2);
if (!file || !prefix) {
  console.error('Usage: node scripts/render-pdf.mjs <file.pdf> <outPrefix> [scale] [pages e.g. 1,3]');
  process.exit(1);
}
const doc = await getDocument({ data: new Uint8Array(readFileSync(file)), disableFontFace: true, useSystemFonts: false }).promise;
const want = pages ? pages.split(',').map(Number) : Array.from({ length: doc.numPages }, (_, i) => i + 1);
for (const n of want) {
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale: Number(scale) });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  writeFileSync(`${prefix}-${n}.png`, canvas.toBuffer('image/png'));
  console.log(`${prefix}-${n}.png`);
}
