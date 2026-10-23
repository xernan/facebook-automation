# Handoff (2026-10-24)

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

## Open (needs owner)
- Review + merge PR #1 (staging -> main): https://github.com/xernan/facebook-automation/pull/1 (CI green).
- Delete old repo cardmaxmarketing-blip/facebook-automation (Settings > Danger Zone). gh lacks delete_repo scope.
- Make the Meta App + token, fill `.env` yourself (never in chat), `npm run doctor`, restart Claude.
- First live run: read-only on a test Page, then FB_WRITE_ENABLED=true.

## Next
1. Owner setup -> doctor -> read-only smoke test -> writes on test Page.
2. /qa on the live flows.
3. Phase 2 options (owner decides): Instagram, Marketing API (ads), lead alerts.
