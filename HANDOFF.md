# Handoff (2026-10-24, live)

## Done
- MCP server, 22 tools + `fb_setup_status`, Graph API v26.0: pages, posts (+schedule, photo, video),
  comments, Messenger (+private reply), insights, reviews, Lead Ads leads (+CSV export), read-only graph_get.
- Setup mode: server connects even with no/bad `.env`; every tool answers "Setup needed: ...".
  (Was the cause of "facebook: Connection closed".)
- Safety: write switch (off by default), confirm on delete, idempotency keys, read/write rate
  limits, page authorization check, appsecret_proof, token redaction, media-folder-only uploads,
  CSV formula-injection guard.
- 41 tests pass (incl. MCP client<->server, `.env.example` parses to blanks + documents every key).
- Public GitHub repo xernan/facebook-automation (free Actions). CI on staging + main.

## Live status (2026-10-24)
- `npm run login` (new): Facebook Login -> long-lived token saved to .env. Used live, works.
- Token: 8/10 permissions. Missing leads_retrieval + pages_manage_ads
  (app has no Lead Ads use case -> "Invalid Scopes"). Used `--no-leads`.
- Pages: 3 from me/accounts + the business Page (Business-owned, via FB_EXTRA_PAGE_IDS / direct lookup).
  Names and ids are in local memory only (public repo).
- Live read OK on the business Page: get_page, posts, scheduled, get_post, comments, conversations,
  page+post insights (new *_total_media_view_unique names), reviews. Writes blocked (OFF).

- New: fb_messenger_leads + fb_comment_leads (leads from Messenger/comments, CSV export). Live on the business Page:
  2 Messenger leads, both with phone/email. Owner chose these over Lead Ads.

- Leads tag banks named + carded yes/no (Card Max = free credit card application help; every PM/commenter is a lead).
- the business Page observations (2026-10-24): last 25 posts have 0 comments / 0 reactions; several duplicates;
  3 public test posts deleted 2026-10-24 (owner OK). FB_WRITE_ENABLED=true now; live delete verified.

- QA pass 2026-10-24 (76 tests): fixed token in tool output (scrub all results), double post after
  write timeout (key stays failed), same idempotency key reused for other action (now refused),
  comment leads only first 100 per post (now pages), cursors >500 chars broke page 2 (live repro).
  Live negative paths OK: unknown page, other page's post, retired metric.
- Low fixes 2026-10-24: unknown page id refresh cooldown (FB_PAGES_REFRESH_COOLDOWN_SEC), Messenger
  lead page size is config (FB_LEADS_CHATS_PER_PAGE). 78 tests. Auto-resume cron stopped (nothing left without owner decision).

- QA pass 2 (2026-10-24, 84 tests): cut-off answer to a write now maybe-done (no double post),
  base64 cursors, doctor OK when only Lead Ads perms missing. Live read smoke test of all main tools OK. PR #5.

- Messenger application flow (2026-10-24, staging, not live yet): fb_flow_pending/answer/status/reset +
  `npm run watch` (polls, wakes headless Claude with flow tools only). Owner texts in git-ignored flow.json.
  Qualifier is locked owner logic (no card -> 180-day cooldown; all 4 excluded banks -> stop). No existing-card
  details collected, no signature (owner decision). 121 tests. Next: owner tests the flow in chat, then set
  FB_FLOW_PAGE_ID + FB_FLOW_DIR in .env (owner), restart Claude, run the watcher at logon.

- 2026-10-24 late (staging 8cd7837, 205 tests, not live): Messenger flow (buttons, suggestions, ID review with owner
  ID rules), bank PDF autofill (Metrobank/EastWest/China Bank, templates git-ignored), Default Form editor + local
  dashboard (`npm run dashboard`, http://localhost:8790), print via Acrobat, CLIENTS.xlsx. Income/TIN are never
  invented. Next: owner sets FB_FLOW_PAGE_ID, FB_FLOW_DIR, FB_PDF_TEMPLATES_DIR in .env; test with own PM; watcher +
  dashboard at logon (owner OK).

- 2026-10-24 (b791105, 215 tests): optional TIN question (Skip) + TIN from ID; office-number directory
  (FB_FLOW_DIR/company-phones.json, real numbers with source or typed by owner, per company + city): finalize fills
  blank office phone, Default Form "Find number", Settings lists/removes. Random TIN/phone from the card app NOT ported.

- Verified 2026-10-31: 286 tests + secret scan pass, doctor OK. Logon task for the bots exists; watch, commentwatch and
  dashboard are running. Staging CI green; staging is 68 commits ahead of main (last PR to main: #5).
  Business Page, last 16 posts: 0 reactions, 1 comment, 6 shares. 2 Messenger chats; the one finished by someone other
  than the owner is not yet confirmed as a real lead.

## Open (needs owner)
- Bot duplicates fixed 2026-10-31: logs showed hundreds of retries until 10:37; one keeper per bot now, live-tested. PR #6 merged to main on owner's instruction. Bot silence on 2026-10-31: outdated Claude CLI, updated to 2.1.316; run logs the reason on failure. Flow rules unchanged: finished chats get replies only to questions. Left for owner: backup of local-only files, fill missing fields on 2 applicants.
- GitHub done 2026-10-24: PR #1 merged to main; old cardmaxmarketing-blip repo deleted.
- Lead Ads dropped by owner (no Lead Ads use case; login with all scopes gave "Can't load URL").

## Next
1. Claude Desktop works 2026-10-24: facebook server connected, 25 tools. Note: the Brave-installed
   "Claude" app is the web version (no local server); use the real Desktop app (Start menu).
   Desktop MCP log: LocalAppData Claude\logs\mcp-server-facebook.log.
2. PRs #2-#4 merged 2026-10-24, main CI green (#4: Business Pages show as usable in fb_list_pages). Claude Desktop: facebook server added to its config
   2026-10-24 (backup .bak-2026-10-24 beside it); owner must fully quit + reopen Desktop.
3. Phase 2 options (owner decides): Instagram, Marketing API (ads), lead alerts.
