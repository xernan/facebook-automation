import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadConfig } from './config.js';
import { GraphClient } from './graph.js';
import { IdempotencyStore } from './idempotency.js';
import type { Ctx } from './tools.js';

// Project root = one level above src/ or dist/, so .env is found whatever the cwd is.
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createContext(): Ctx {
  // quiet: dotenv must not print to stdout, which carries the MCP protocol.
  dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });
  const cfg = loadConfig(process.env, ROOT_DIR);
  return {
    cfg,
    graph: new GraphClient(cfg),
    idem: new IdempotencyStore(cfg.FB_IDEMPOTENCY_TTL_MIN * 60_000),
  };
}
