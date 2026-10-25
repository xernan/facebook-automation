import path from 'node:path';
import { z } from 'zod';

// Every tunable lives here with a default and min/max bounds. Override any of them in .env.
const intIn = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const boolFlag = (def: boolean) =>
  z
    .enum(['true', 'false'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true');

export const configSchema = z.object({
  FB_USER_ACCESS_TOKEN: z.string().min(20).optional(),
  FB_PAGE_ACCESS_TOKEN: z.string().min(20).optional(),
  FB_PAGE_ID: z.string().regex(/^\d+$/).optional(),
  FB_APP_SECRET: z.string().min(16).optional(),
  FB_EXTRA_PAGE_IDS: z.string().regex(/^\s*\d+(\s*,\s*\d+)*\s*$/).optional(),
  FB_APP_ID: z.string().regex(/^\d+$/).optional(),
  FB_GRAPH_VERSION: z.string().regex(/^v\d{2,3}\.0$/).default('v26.0'),
  FB_WRITE_ENABLED: boolFlag(false),
  /** Messenger replies (bot and fb_send_message). Off until the owner OKs our wording against Meta standards. */
  FB_MESSENGER_LIVE: boolFlag(false),
  FB_READ_RATE_PER_MIN: intIn(120, 1, 600),
  FB_WRITE_RATE_PER_MIN: intIn(10, 1, 60),
  FB_HTTP_TIMEOUT_MS: intIn(15000, 1000, 60000),
  FB_IDEMPOTENCY_TTL_MIN: intIn(1440, 1, 10080),
  FB_MAX_LIST_LIMIT: intIn(100, 1, 100),
  FB_SCHEDULE_MIN_MINUTES: intIn(10, 10, 1440),
  FB_SCHEDULE_MAX_DAYS: intIn(30, 1, 75),
  FB_MAX_UPLOAD_MB: intIn(10, 1, 100),
  FB_LEADS_SCAN_MAX: intIn(200, 1, 2000),
  FB_LEADS_MESSAGES_PER_CHAT: intIn(25, 1, 100),
  FB_LEADS_SCAN_POSTS: intIn(25, 1, 100),
  FB_LEADS_CHATS_PER_PAGE: intIn(25, 1, 100),
  FB_PAGES_REFRESH_COOLDOWN_SEC: intIn(60, 0, 3600),
  FB_LOGIN_PORT: intIn(8765, 1024, 65535),
  FB_LOGIN_TIMEOUT_MIN: intIn(5, 1, 30),
  FB_MEDIA_DIR: z.string().default('media'),
  FB_EXPORT_DIR: z.string().default('exports'),
  // Messenger application flow + watcher
  FB_FLOW_FILE: z.string().default('flow.json'),
  FB_FLOW_DIR: z.string().default('exports/flow'),
  FB_PDF_TEMPLATES_DIR: z.string().default('pdf-templates'),
  FB_FLOW_PAGE_ID: z.string().regex(/^\d+$/).optional(),
  FB_FLOW_COOLDOWN_DAYS: intIn(180, 1, 730),
  FB_FLOW_NUDGE_AFTER_HOURS: intIn(3, 1, 20),
  FB_FLOW_REPLY_WINDOW_HOURS: intIn(23, 1, 24),
  FB_FLOW_MESSAGES_PER_CHAT: intIn(10, 1, 50),
  FB_FLOW_MAX_IMAGE_MB: intIn(10, 1, 25),
  FB_WATCH_INTERVAL_SEC: intIn(10, 3, 600),
  FB_WATCH_ACTIVE_INTERVAL_SEC: intIn(3, 2, 60),
  FB_WATCH_ACTIVE_MINUTES: intIn(15, 1, 120),
  FB_WATCH_CLAUDE_TIMEOUT_MIN: intIn(5, 1, 30),
  FB_WATCH_CLAUDE_BIN: z.string().optional(),
  FB_DASHBOARD_PORT: intIn(8790, 1024, 65535),
  // Comment replies (src/comments.ts). Off until the owner turns them on.
  FB_COMMENTS_LIVE: boolFlag(false),
  FB_COMMENT_INTERVAL_SEC: intIn(120, 60, 3600),
  FB_COMMENT_MIN_DELAY_SEC: intIn(90, 30, 3600),
  FB_COMMENT_MAX_PER_HOUR: intIn(15, 1, 60),
  FB_COMMENT_MAX_PER_DAY: intIn(60, 1, 300),
  FB_COMMENT_POST_DAYS: intIn(7, 1, 30),
  FB_COMMENT_PRIVATE_REPLY: boolFlag(false),
});

export type RawConfig = z.infer<typeof configSchema>;
export type Config = RawConfig & { mediaDir: string; exportDir: string; flowFile: string; flowDir: string; templatesDir: string };

export function loadConfig(env: NodeJS.ProcessEnv, rootDir: string, { requireToken = true } = {}): Config {
  // Blank values in .env mean "not set".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = configSchema.safeParse(cleaned);
  if (!parsed.success) {
    // Only name the bad keys; never echo values (they may be tokens).
    const keys = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new Error(`Invalid config in .env: ${keys}`);
  }
  const c = parsed.data;
  if (requireToken && !c.FB_USER_ACCESS_TOKEN && !c.FB_PAGE_ACCESS_TOKEN) {
    throw new Error('Missing token: set FB_USER_ACCESS_TOKEN or FB_PAGE_ACCESS_TOKEN in .env');
  }
  if (c.FB_PAGE_ACCESS_TOKEN && !c.FB_PAGE_ID) {
    throw new Error('FB_PAGE_ID is required when FB_PAGE_ACCESS_TOKEN is set');
  }
  return {
    ...c,
    mediaDir: path.resolve(rootDir, c.FB_MEDIA_DIR),
    exportDir: path.resolve(rootDir, c.FB_EXPORT_DIR),
    flowFile: path.resolve(rootDir, c.FB_FLOW_FILE),
    flowDir: path.resolve(rootDir, c.FB_FLOW_DIR),
    templatesDir: path.resolve(rootDir, c.FB_PDF_TEMPLATES_DIR),
  };
}
