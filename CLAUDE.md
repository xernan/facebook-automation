# Facebook Automation

MCP server that lets Claude manage the owner's Facebook Pages (posts, scheduling, comments,
Messenger, insights, reviews, Lead Ads leads) through the official Meta Graph API. One user:
the owner, on this computer. No scraping, no browser automation, no personal-profile actions.

| Folder | What |
|---|---|
| `src/` | MCP server (TypeScript, `@modelcontextprotocol/sdk`, zod) |
| `src/tools.ts` | Every tool: name, zod input, handler. Add new tools here. |
| `src/graph.ts` | Graph API client: page-token lookup, appsecret_proof, rate limits, error mapping |
| `src/config.ts` | All tunables with defaults and min/max bounds (read from `.env`) |
| `tests/` | vitest, fake Graph API in `tests/helpers.ts` |
| `media/` | Only folder images may be uploaded from (git-ignored) |
| `exports/` | Lead CSVs (personal data, git-ignored) |

Setup for the owner: `README.md` and `docs/SETUP.md`.

## Commands

```bash
npm run build        # required after any src change; Claude runs dist/server.js
npm run check        # typecheck + tests + secret scan
npm run doctor       # checks .env/token, lists Pages, prints no secrets
```

## Rules that are easy to break

- Official Graph API only. Never add scraping, headless browsers, login-with-password,
  personal profile or Group posting, or cold DMs. Meta bans accounts for these.
- Every tool input is a zod schema; `callTool` parses it `.strict()`. Every page-scoped
  call goes through `graph.get/post/del(pageId, ...)`, which checks the page is managed by
  the token (authorization) and uses that page's token.
- Mutating tools set `write: true`; they are blocked unless `FB_WRITE_ENABLED=true`.
  Destructive tools require `confirm: true`. Posting/messaging tools take `idempotency_key`.
- Before using a write tool on the owner's real Page, show the exact text/time and get a yes.
  Posts, replies and messages are public and outward-facing.
- Messenger: only reply within 24h of the person's last message, or one private reply per
  comment. Message tags are never for promotions.
- No hard-coded tunables: add new limits/timings to `src/config.ts` with bounds and
  document them in `.env.example`.
- Never read, print or copy `.env`. Never log tokens or lead data; stdout is the MCP
  channel, logs go to stderr only. Errors pass through `graph.scrub()`.
- Lead data is personal data (Data Privacy Act). Keep it in `exports/`, never commit it.
- Graph API version is `FB_GRAPH_VERSION` (default v26.0). Insights metric names change
  between versions; check Meta's changelog before "fixing" a metric error in code.

## Git

- Work lands on `staging`; `main` only receives staging -> main PRs after CI is green.
- Conventional commits. Hooks live in `.githooks/` (`git config core.hooksPath .githooks`):
  secret scan + typecheck + tests on every commit.
