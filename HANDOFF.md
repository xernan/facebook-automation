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
  lead page size is config (FB_LEADS_CHATS_PER_PAGE). 78 tests. Auto-resume cron every ~3h (session-only).

## Open (needs owner)
- GitHub done 2026-10-24: PR #1 merged to main; old cardmaxmarketing-blip repo deleted.
- Lead Ads dropped by owner (no Lead Ads use case; login with all scopes gave "Can't load URL").

## Next
1. Owner: confirm facebook server shows in Claude Desktop (Settings > Developer).
2. PR #2 merged 2026-10-24, main CI green. Claude Desktop: facebook server added to its config
   2026-10-24 (backup .bak-2026-10-24 beside it); owner must fully quit + reopen Desktop.
3. Phase 2 options (owner decides): Instagram, Marketing API (ads), lead alerts.
