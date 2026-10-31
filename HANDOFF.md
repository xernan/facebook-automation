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
  - Flow: bank and pending-bank buttons, answer checks by code then Claude (place of birth, home and office address), spelling fixes and flags, ID photo received reply, checks every 5 s quiet and 2 s active. Office address suggestions removed for speed.

## Open

Next when the owner comes back:
1. Prove PDFs through the real chat. The 2026-10-31 05:31 UTC test made none because Claude called fb_lead_hold (ids_do_not_match): the ID name differs from the test account's Facebook name and the photo looked like a screenshot. The later reset erased the hold. Owner rule: Facebook names are often aliases, so an ID is never compared with them (fixed); IDs are compared only with each other. A screenshot still holds. Finalize works in a dry run. Repeat the test with a clear photo of an ID, or use Release on the dashboard, and do not reset until the folder shows.
2. Finish the wording review of the bank question with the owner.
3. Stranger test: one person with no role on the Page or Meta app. Not proven yet.
4. Staging to main PR (15 commits ahead on 2026-10-31, CI green) after the test passes.

Owner:
5. Backup on the second disk is from before the 10-31 flow changes; copy flow.json again when stable. .env copy and an encrypted off-site copy are still the owner's job.
6. Approve the exact text of the 3 post drafts. Nothing is posted yet.
7. Decide: skip the PDF of a bank with a pending application? Today it is still made.
8. Applicants on the dashboard: #1 is the owner's test account. #2 is flagged manual entry; only SSS/GSIS and the signature are left.

Claude, low:
9. Autofill code (quickReply, autofill field) is unused: tapping sent only the words, so it was removed from flow.json. The "Email" chip still showed on the owner's phone although nothing sends it; check it on another account.
10. Run npm run login before data access ends on 2027-01-21. Keep the Claude CLI updated: an old one stops every AI reply.

11. Office address rule (owner, 2026-10-31): Claude looks for it on the web and offers what it finds; if nothing or "Iba", one line only: "I type ang complete address ng company." The part-by-part code (place_part, cityFromAnswer) is unused in flow.json; remove it if it stays that way. Facebook's own "Confirm your address" sheet shows on the client's phone when they send an address (owner saw it). It is not from our code or any setting the API can read, and the chat goes on without tapping it. Do not look for it in the code again.

Owner decides later: Instagram, Marketing API (ads), lead alerts.

## Reference
- Use the real Claude Desktop app (Start menu); the Brave-installed one is the web version. Log: LocalAppData Claude\logs\mcp-server-facebook.log.
- Lead Ads dropped by owner: the app has no Lead Ads use case. Missing leads_retrieval and pages_manage_ads is expected.
