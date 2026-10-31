# Handoff (updated 2026-10-31, live)

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

- Through 2026-10-25 (48 commits since the entry above, read from git log):
  - Page restricted from messaging by Meta (#2022, 28 days) after a greeting that listed OTP/CVV/PIN. Added: Community
    Standards guard on every outgoing text, FB_MESSENGER_LIVE switch, no message tags, pause on block, one watcher.
  - Comment bot (FB_COMMENTS_LIVE): human-sounding replies, hourly and daily caps, optional DM that resumes an application.
  - Test mode (dashboard), Marketing tab (bank results, thank-you drafts with client OK, post stats, draft check),
    weekly target and quota, funnel, source per applicant, archive.
  - Flow: instant script replies, ID photos saved at once, one reminder after 3 quiet hours, Claude can hold doubtful IDs.
  - PDF owner rules: name on card fit, declarations NO, best time to call, self-employed boxes, tenure, email domain, College.
  - Bots start at Windows sign-in through a scheduled task and restart when they stop.

- 2026-10-31:
  - Bot silent: Claude CLI too old for its model. Updated to 2.1.316; failed runs now log the reason. Bot reply seen live.
  - Fixed: duplicate keepers (one per bot), dashboard tests starting PowerShell, a spawn error skipping ClaudeBrake.
  - PR #6 merged to main. The owner's test chat had finished the flow on 10-25; that account was reset with fb_flow_reset.
  - Flow rules are final (see the flow code). Finished chats do not restart; the bot only answers what they ask.
  - Business Page, last 16 posts: 0 reactions, 1 comment, 6 shares; 2 followers.

## Open
Owner:
1. Done: PR #7 merged 2026-10-31, main CI green.
2. Backup done 2026-10-31 on the PC's second disk: flow file, leads, templates (101 files, hashes match). Not encrypted, not off-site. Left for owner: copy .env (Claude never copies it), and an encrypted off-site copy.
3. Finish the test PM from the start after the reset (through ID photo and PDFs).
4. Ask one person with no role on the Page or Meta app to PM the Page. Not proven yet that strangers get replies.
5. Dashboard applicants: one is the owner's test account. The other does not match the 2 current chats; owner confirms who it is. If real, only SSS/GSIS and the signature are left.

Claude:
6. 3 post drafts written and passed the content guard (2026-10-31). Owner approves the exact text before anything is posted.
7. Done: token checked 2026-10-31, no expiry date; data access runs until 2027-01-21. Run npm run login before then.

Owner decides later: Instagram, Marketing API (ads), lead alerts.

## Reference
- Use the real Claude Desktop app (Start menu); the Brave-installed one is the web version. Log: LocalAppData Claude\logs\mcp-server-facebook.log.
- Lead Ads dropped by owner: the app has no Lead Ads use case. Missing leads_retrieval and pages_manage_ads is expected.
