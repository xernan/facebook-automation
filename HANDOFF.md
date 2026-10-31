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

Owner priority (2026-10-31): finding clients comes first. Code only for real failures; no new features. The pending application question stays at 4 banks (owner). The first real client doubles as the stranger test.

Marketing plan (2026-10-31; no older written plan found, and no results yet). Goal for week 1: 5 real people message the Page and 1 finishes an application; the dashboard target stays 40 a week. Owner by hand: message 10 contacts or old clients a day, share in 3-5 groups a day within each group's rules, pin the Oct 31 post. Page: the 11 scheduled photo posts. Every applicant gets "Where they came from" set. Claude: on Nov 8 count chats and sources, then keep what brings people. The owner deleted the Oct 30 post that did not match the offer (the delete tool was refused by the permission check, so it was done by hand).
Ads: on hold by the owner, look again on Nov 8 with the chat count. Numbers on 2026-10-31: 16 posts, reach 61, 1 click, 0 reactions; daily reach 0-2 before Oct 24, then 48-513, last 96; 4 chats, none clearly a real client (not confirmed). Proposal not approved: PHP 1,000 test, PHP 200 a day for 5 days, to Messenger, with the second-card image; stop at PHP 300 with no message. Our Facebook tool has no ads access; it would be set up in Ads Manager through Chrome and the owner presses Publish. The Financial Products and Services category is required for the U.S.; no Philippine rule was found, so check it then. Claude in Chrome worked here after the owner ran /chrome.

Next when the owner comes back:
1. PDFs through the real chat: proven 2026-10-31 (13:24 UTC). Metrobank, EastWest, China Bank and ID photos were made with an ID note and no hold; the owner saw the China Bank PDF. Field-by-field accuracy of the 3 PDFs has not been checked by Claude.
2. Finish the wording review of the bank question with the owner.
3. Stranger test: one person with no role on the Page or Meta app. Not proven yet.
4. Staging to main PR (30 commits ahead on 2026-10-31, CI green at the last check) after the test passes.

Owner:
5. Backup on the second disk is from before the 10-31 flow changes; copy flow.json again when stable. .env copy and an encrypted off-site copy are still the owner's job.
6. Approve the exact text of the 3 post drafts. Nothing is posted yet.
7. Decided (owner, 2026-10-31): a pending application never stops the flow while a bank among the 5 can still be applied to, and that bank still gets its PDF, as the code does today. Our 5 banks: Metrobank, BPI, RCBC, EastWest, China Bank (owner, 2026-10-31). The chat stops only when the client has cards at all 5. BPI and RCBC have no PDF yet, so someone left with only those finishes the flow with no bank PDF; the owner is fine with that. To add a bank PDF: put the template in the templates folder, add it to BANKS and BANK_NAME in src/application.ts (the compiler then asks for its bank-only boxes) and to PDF_BANKS in public/dashboard.js. Open: the pending application question and its buttons still list 4 banks, without China Bank. "Wala dito" stays as it is (owner, 2026-10-31): the card company stays blank and no bank question is added, since what matters is that they have a card.
8. Applicants on the dashboard: #1 is the owner's test account. #2 is flagged manual entry; only the signature is left. SSS/GSIS stays blank on every form (owner rule, 2026-10-31); MISSING.txt in folders made earlier still lists it until they are saved again.

Claude, low:
9. Autofill code (quickReply, autofill field) is unused: tapping sent only the words, so it was removed from flow.json. The "Email" chip still showed on the owner's phone although nothing sends it; check it on another account.
10. Run npm run login before data access ends on 2027-01-21. Keep the Claude CLI updated: an old one stops every AI reply.

11. Office address rule (owner, 2026-10-31): Claude looks for it on the web and offers what it finds; if nothing or "Iba", one line only: "I type ang complete address ng company." The part-by-part code (place_part, cityFromAnswer) is unused in flow.json; remove it if it stays that way. Facebook's own "Confirm your address" sheet shows on the client's phone when they send an address (owner saw it). It is not from our code or any setting the API can read, and the chat goes on without tapping it. Do not look for it in the code again.

16. Dashboard UI QA in Chrome 2026-10-31, read-only: Applicants, Archive, Marketing, Settings, applicant page and Default Form open with no console errors. The SSS/GSIS box is gone. Not tested: save, print, phone width. Low, not fixed (clients first): the applicant list shows UTC time (13:24 for 9:24 PM, public/dashboard.js:68); "Has cards:" shows nothing for "Wala dito". Fixed: one ID note said the mother's name was left out although it was kept; the answer and each bank's mother box value were checked in the saved data, the finished PDFs were not read (flattened, and Chrome's PDF viewer cannot be captured), and the bot is now told never to write that. "Where they came from" is set by hand on each applicant, and all 3 are Unknown.

Owner decides later: Instagram, Marketing API (ads), lead alerts.
12. Facebook "Confirm your address" sheet, checked in Chrome 2026-10-31: shows after the home address answer and comes from facebook.com. Pressing X lets the chat continue (owner tested), so it does not block applications. No off switch found in Inbox settings, Commerce Manager (no shop or catalog), Page setup, Advanced Messaging or settings search. Turning Data sharing OFF did not stop it; it is back ON, as before. Nothing else was changed. No cause proven; Meta docs do not describe it. Not tested on an account that never saw the old autofill buttons.
13. Dashboard funnel checked 2026-10-31: 0 complete this week and 2 this month is correct. Weeks start Monday (10-26) and both folders were completed Sunday 10-25. "Started" counts only people still in state.json, and a reset removes them, so test resets make pct_complete look like 100%. All 3 chats finished on 10-31 (05:31, 06:49, 08:05 UTC) were held by Claude because the ID was a photo of a phone screen or looked unreal, then the resets erased the holds; their lead files remain with no folder. Those were deliberate worst-case tests. Owner rule: never hold, what the client sends is the client's decision; the bot now always finalizes and writes any doubt as an ID note. PDFs through the real chat are still not proven: repeat the test. The manager with full control who joined a group as the Page on Oct 25 is the owner (owner confirmed). The passkey warning is done (owner). Flaky test fixed: PDF and ID tests passed the 5 s limit on a busy PC, and a timed-out test could also fail the next one; vitest.config.ts now allows 60 s.
14. Analytics 2026-10-31: Page reach 1,209 and views 2,422 over 28 days, 0 views from ads, 2 followers; the 16 posts' own numbers add up to only 63 reach and 147 views. Where the rest comes from is not proven (owner's group shares is the guess). Photo posts reach 5.5 on average, text posts 1.3. Do not judge the Page by the post numbers alone. Sample is 6 days. The owner did the group shares by hand.
15. Schedule 2026-10-31: the 11 posts for Nov 1-11 are now photo posts with the same text and time (the Oct 31 post had already gone out as text). Images are in media/schedule-2026-11, git-ignored, made with a plain brand card. Compare their reach with the 1.3 average of text posts after Nov 11.

## Reference
- Use the real Claude Desktop app (Start menu); the Brave-installed one is the web version. Log: LocalAppData Claude\logs\mcp-server-facebook.log.
- Lead Ads dropped by owner: the app has no Lead Ads use case. Missing leads_retrieval and pages_manage_ads is expected.
