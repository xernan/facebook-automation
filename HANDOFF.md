# Handoff (2026-10-23)

## Done
- MCP server, 22 tools on Graph API v26.0: pages, posts (+schedule, photo, video), comments,
  Messenger (+private reply), insights, reviews, Lead Ads leads (+CSV export), read-only graph_get.
- Safety: write switch (off by default), confirm on delete, idempotency keys, read/write rate
  limits, page authorization check, appsecret_proof, token redaction, media-folder-only uploads,
  CSV formula-injection guard.
- 36 tests pass; 6 mutation checks proved the guards are tested. Secret scan + pre-commit hook + CI.
- Docs: README.md (owner, Tagalog), docs/SETUP.md (token steps), CLAUDE.md (agent rules).

## Open
- Owner: make the Meta App + token, fill .env (never in chat), `npm run doctor`.
- No live Graph API test yet (no token). First live run: read-only on a test Page.
- No git remote yet: create GitHub repo, push `staging`, confirm CI green.
- Add test: `.env.example` parses with dotenv to all-blank values (inline `#` comments).

## Next
1. Owner setup -> doctor -> read-only smoke test -> FB_WRITE_ENABLED=true on test Page.
2. Run /qa on the live flows.
3. Phase 2 options: Instagram (Graph API), Marketing API (ads), webhook for instant new-lead alerts.
