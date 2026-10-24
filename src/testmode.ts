import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// Test mode: the bots (Messenger flow and comment replies) only answer the people listed here, so the owner can test
// on the live Page without anyone else getting an automated reply. It is ON by default (an empty list answers nobody);
// the owner turns it off in the dashboard for the soft launch.

const FILE = 'test-mode.json';
export const testModeSchema = z.object({
  on: z.boolean(),
  // Messenger PSIDs and/or comment author ids (Facebook gives the same person different ids in each).
  ids: z.array(z.string().regex(/^\d{1,25}$/)).max(20),
});
export type TestMode = z.infer<typeof testModeSchema>;

export async function loadTestMode(dir: string): Promise<TestMode> {
  try {
    return testModeSchema.parse(JSON.parse(await fs.readFile(path.join(dir, FILE), 'utf8')));
  } catch {
    return { on: true, ids: [] };
  }
}

export async function saveTestMode(dir: string, input: unknown): Promise<TestMode> {
  const tm = testModeSchema.parse(input);
  tm.ids = [...new Set(tm.ids)];
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, FILE), JSON.stringify(tm, null, 2), 'utf8');
  return tm;
}

/** True when the bots may answer this person. */
export const botMayAnswer = (tm: TestMode, id: string | undefined) => !tm.on || (!!id && tm.ids.includes(id));
