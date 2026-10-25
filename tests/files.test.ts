import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { replaceFile } from '../src/files.js';

describe('replaceFile (atomic save on Windows)', () => {
  const setup = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fbkit-'));
    const tmp = path.join(dir, 'x.tmp');
    const dest = path.join(dir, 'x.json');
    writeFileSync(tmp, 'new');
    writeFileSync(dest, 'old');
    return { tmp, dest };
  };
  const busy = (n: number, code = 'EPERM') => {
    let calls = 0;
    const fn = (async (a: string, b: string) => {
      if (++calls <= n) throw Object.assign(new Error(code), { code });
      return fs.rename(a, b);
    }) as typeof fs.rename;
    return { fn, calls: () => calls };
  };

  it('retries while a scanner or OneDrive holds the file, then replaces it', async () => {
    const { tmp, dest } = setup();
    const r = busy(3);
    await replaceFile(tmp, dest, r.fn);
    expect(readFileSync(dest, 'utf8')).toBe('new');
    expect(r.calls()).toBe(4);
  });

  it('gives up after a few tries, keeps the old file and removes the temp file', async () => {
    const { tmp, dest } = setup();
    await expect(replaceFile(tmp, dest, busy(99, 'EBUSY').fn, 3)).rejects.toThrow(/EBUSY/);
    expect(readFileSync(dest, 'utf8')).toBe('old');
    expect(existsSync(tmp)).toBe(false);
  });

  it('does not retry other errors', async () => {
    const { tmp, dest } = setup();
    const r = busy(1, 'ENOENT');
    await expect(replaceFile(tmp, dest, r.fn)).rejects.toThrow(/ENOENT/);
    expect(r.calls()).toBe(1);
  });

  it('every save in src goes through replaceFile (no bare fs.rename)', () => {
    for (const f of readdirSync('src').filter((x) => x.endsWith('.ts') && x !== 'files.ts'))
      expect(readFileSync(path.join('src', f), 'utf8'), f).not.toMatch(/fs\.rename\(/);
  });
});
