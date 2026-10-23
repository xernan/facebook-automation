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
- Token in .env works (user token, app 1086733300456198, extended, appsecret_proof on).
- Page: CARD MAX (1235234309673692), Business-owned. Found via debug_token fallback (me/accounts is empty for it).
- Live read OK: list_pages, get_page, list_posts (+scheduled), list_conversations, page/post insights (new metric names).
- Blocked by missing permissions: pages_manage_engagement, pages_read_user_content, pages_manage_metadata,
  read_insights, leads_retrieval, pages_manage_ads -> get_post counts, comments, reviews, lead forms.

## Open (needs owner)
- Add the 6 missing permissions (app Use cases -> Customize), make a new token, pick CARD MAX, extend, save .env.
- Review + merge PR #1 (staging -> main): https://github.com/xernan/facebook-automation/pull/1 (CI green).
- Delete old repo cardmaxmarketing-blip/facebook-automation (Settings > Danger Zone). gh lacks delete_repo scope.
- Restart Claude so the facebook MCP connects with the token.
- Writes: FB_WRITE_ENABLED=true only after owner OKs a first test post text.

## Next
1. Owner setup -> doctor -> read-only smoke test -> writes on test Page.
2. /qa on the live flows.
3. Phase 2 options (owner decides): Instagram, Marketing API (ads), lead alerts.
