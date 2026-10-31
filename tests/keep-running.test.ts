import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('keep-running.ps1', () => {
  it('leaves quietly before its restart loop when another keeper runs the same bot', () => {
    const script = readFileSync('scripts/keep-running.ps1', 'utf8');
    const mutex = script.indexOf('Mutex($false, "Local\\fb-automation-keep-running-$Bot")');
    const leave = script.indexOf('exit 0');
    const loop = script.indexOf('while ($true)');
    expect(mutex).toBeGreaterThan(-1);
    expect(leave).toBeGreaterThan(mutex);
    expect(loop).toBeGreaterThan(leave);
  });
});
