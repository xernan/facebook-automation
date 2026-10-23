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
- Token: app 1086733300456198, 8/10 permissions. Missing leads_retrieval + pages_manage_ads
  (app has no Lead Ads use case -> "Invalid Scopes"). Used `--no-leads`.
- Pages: Oink-Oink, PenTest Philippines, Sexy Tiktoker (me/accounts) + CARD MAX 1235234309673692
  (Business-owned, via FB_EXTRA_PAGE_IDS / direct lookup).
- Live read OK on CARD MAX: get_page, posts, scheduled, get_post, comments, conversations,
  page+post insights (new *_total_media_view_unique names), reviews. Writes blocked (OFF).

- New: fb_messenger_leads + fb_comment_leads (leads from Messenger/comments, CSV export). Live on CARD MAX:
  2 Messenger leads, both with phone/email. Owner chose these over Lead Ads.

- Leads tag banks named + carded yes/no (Card Max = free credit card application help; every PM/commenter is a lead).
- CARD MAX observations (2026-10-24): last 25 posts have 0 comments / 0 reactions; several duplicates;
  3 public test posts ("Test post - BPI...", "Test Post", "Test validation post...") -> owner to OK deletion.

## Open (needs owner)
- Lead Ads dropped by owner (no Lead Ads use case; login with all scopes gave "Can't load URL").
- Merge PR #1 on xernan/facebook-automation; delete old cardmaxmarketing-blip repo.
- Start a NEW Claude chat so the facebook MCP tools load (this session started before .env existed).
- Writes: FB_WRITE_ENABLED=true only after owner OKs a first test post text.

## Next
1. Owner setup -> doctor -> read-only smoke test -> writes on test Page.
2. /qa on the live flows.
3. Phase 2 options (owner decides): Instagram, Marketing API (ads), lead alerts.
