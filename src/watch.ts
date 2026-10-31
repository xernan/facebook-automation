#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT_DIR, createContext } from './context.js';
import { findPending, flowTools, latestChatTime, sendNudges, showTyping } from './flowtools.js';
import { GraphError } from './graph.js';
import { ChatCheck, ClaudeBrake, isMessagingBlocked, pendingKey, runClaudeProcess, takeLock } from './watchguard.js';

// Watcher: checks the Page's Messenger without AI (every FB_WATCH_ACTIVE_INTERVAL_SEC while someone is chatting,
// else every FB_WATCH_INTERVAL_SEC; slower on its own when Meta says we are calling too often). Plain answers the
// script can handle (greeting, yes/no, buttons, valid numbers, short answers) are answered right away by the code.
// Anything else wakes Claude (headless) with only the flow and messaging tools.
// Logs go to stderr and never include names, messages or tokens.

const ALLOWED = [...['fb_flow_pending', 'fb_flow_answer', 'fb_flow_id_images', 'fb_flow_id_review', 'fb_lead_finalize', 'fb_send_message', 'fb_get_messages'].map((t) => `mcp__facebook__${t}`), 'WebSearch'];

export function operatorPrompt(pageId: string): string {
  return [
    `You answer Messenger chats for Facebook Page ${pageId} using the application flow tools.`,
    `1. Call fb_flow_pending with page_id ${pageId}.`,
    '2. For each person in the list (skip anyone with can_reply=false, except to resend an outbox_pending reply):',
    '   - outbox_pending: call fb_flow_answer kind="answer" with their message ids; it resends the saved reply first.',
    '   - stage "new", or the messages answer current_question: fb_flow_answer kind="answer" with all their message ids.',
    '   - answer_check is set and their message tries to answer: it counts only if it meets answer_check and the parts fit',
    '     together (a real barangay in that city, as far as you can tell). In an address outside Metro Manila, a sitio or purok can',
    '     stand in for the street. Complete: fb_flow_answer kind="answer". Not complete: use fb_send_message to say exactly which',
    '     part is missing and ask them to send the whole answer again, then fb_flow_answer kind="question". Never fill in a part yourself.',
    '   - an off-script question: reply yourself with fb_send_message (recipient_psid), short and friendly in the same',
    '     language they used (Taglish is fine). Do not repeat current_question. After it is sent, call fb_flow_answer',
    '     kind="question" with those message ids: it sends the current question again with its buttons.',
    '   - reply null (finished, excluded or cooldown): reply yourself only if they asked something.',
    '   - needs_id_review: call fb_flow_id_images, look at every photo, then fb_flow_id_review with one entry per photo',
    '     (type, side, clear, has_signature, and name/birthday/sex only if you can read them). The code decides if the IDs are enough.',
    '     clear means readable and whole, nothing else: a screenshot or a photo of a screen counts as clear when you can read it.',
    '   - needs_finalize (a lead file name): the application is complete but has no PDFs yet. Call fb_flow_id_images, then',
    '     fb_lead_finalize with lead_file = that name, as below. Do not message the person for this. Always finalize, whatever',
    "     the IDs look like: what the client sends is the client's decision, so never hold an application. If an ID looks doubtful",
    '     (a screenshot, a photo of a screen, the IDs name different people), say so in id_note, without refusing it. Facebook names',
    '     are often aliases: never compare an ID with the Facebook name.',
    '   - lead_saved: call fb_lead_finalize with what you read on the IDs and found in public info (split addresses: unit/floor/building, street, barangay + zip,',
    '     office phone with its source URL (the branch landline from the company site or map listing), nature of business,',
    '     department, employment type, TIN only if printed on an ID). Leave out what you are not sure of; a saved office',
    '     number for the same company and city is filled in by the code. Never invent income, TIN or phone numbers. Leave SSS/GSIS out.',
    '     Place names: correct misspelled barangay, city, province and place of birth (birth_town) only when you are sure which',
    '     place they meant, and list each one in spelling_fixes ("Muntinlua -> Muntinlupa"). If unsure, keep what they typed; the code flags it.',
    '     A business owner (position Owner, own business): employment_type Self-employed, and WebSearch the business name',
    '     and city for its line of business (e.g. "Dental clinic", "Bakery") as industry. If you cannot find it, leave it out.',
    '     If the result lists a missing HOME or OFFICE address part (street/house no., barangay, city, province), ask the',
    '     applicant for exactly that part in one short message (only within the 24-hour window), then finalize again.',
    '   - next_question.wants_suggestions: you may WebSearch public facts for it (e.g. the branch address of the employer',
    '     they named, or its line of business) and pass up to 5 as suggestions to fb_flow_answer. Only facts you found and',
    '     are sure of. If unsure, pass none. For office_address, always WebSearch the employer in answers_so_far first; pass only',
    '     full addresses (street, barangay, city, province) of that company where the barangay really is in that city and province,',
    '     written "street, barangay, city, province". With none, the code asks them to type it.Never suggest or guess personal details (names, birthplace, home address,',
    "     mother's maiden name).",
    '3. Never ask for a card number, CVV, OTP, PIN or passwords, and never mention them in a reply, not even as a warning',
    '   (Meta restricted the Page for that). Never promise approval, rates or promos. The code refuses such messages.',
    '   If you do not know an answer, say the team will follow up. Never mention servers, APIs or errors.',
    '4. Repeat from step 1 until fb_flow_pending returns an empty list, then stop. Do not do anything else.',
  ].join('\n');
}

function claudeBin(configured?: string): string {
  if (configured) return configured;
  // On Windows "claude" is a .cmd shim that spawn() cannot run without a shell; use the real exe.
  const exe = path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return process.platform === 'win32' && existsSync(exe) ? exe : 'claude';
}

const log = (m: string) => console.error(`[watch ${new Date().toISOString()}] ${m}`);

async function main() {
  const ctx = createContext();
  const pageId = ctx.cfg.FB_FLOW_PAGE_ID;
  if (!pageId) throw new Error('Set FB_FLOW_PAGE_ID in .env (the Page this watcher answers for).');
  if (!ctx.cfg.FB_WRITE_ENABLED) throw new Error('FB_WRITE_ENABLED must be true for the watcher to reply.');
  if (!ctx.cfg.FB_MESSENGER_LIVE) throw new Error('Messenger is not live (FB_MESSENGER_LIVE is off). Owner rule: not live until our wording is checked against Meta standards.');

  const mcpConfig = path.join(tmpdir(), 'facebook-automation-watch-mcp.json');
  writeFileSync(
    mcpConfig,
    JSON.stringify({ mcpServers: { facebook: { command: process.execPath, args: [path.join(ROOT_DIR, 'dist', 'server.js')] } } }),
  );

  const runClaude = () =>
    runClaudeProcess(
      () =>
        spawn(
          claudeBin(ctx.cfg.FB_WATCH_CLAUDE_BIN),
          ['-p', operatorPrompt(pageId), '--mcp-config', mcpConfig, '--strict-mcp-config', '--tools', 'WebSearch', '--allowedTools', ALLOWED.join(',')],
          { cwd: ctx.cfg.flowDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
        ),
      ctx.cfg.FB_WATCH_CLAUDE_TIMEOUT_MIN * 60_000,
      (m) => log(ctx.graph.scrub(m)),
    );

  const answer = flowTools.find((t) => t.name === 'fb_flow_answer')!.handler;
  const brake = new ClaudeBrake();
  const release = takeLock(ctx.cfg.flowDir);
  process.on('exit', release);
  // On Ctrl+C free the lock, then stop the default way. (A hard kill leaves it; the next start sees the pid is gone.)
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.once(sig, () => {
      release();
      process.kill(process.pid, sig);
    });
  let lastChat = 0;
  let backoff = 0; // extra seconds after Meta's "too many calls"
  let blockedUntil = 0; // Meta restricted the Page from messaging: no replies (and no Claude runs) until then
  const BLOCK_RECHECK_MS = 6 * 3_600_000;
  log(`watching every ${ctx.cfg.FB_WATCH_ACTIVE_INTERVAL_SEC}s while chatting, ${ctx.cfg.FB_WATCH_INTERVAL_SEC}s when quiet`);
  const check = new ChatCheck(ctx.cfg.FB_WATCH_FULL_CHECK_SEC * 1000);
  let again = true; // the last round left work behind: read all chats again without waiting for a change
  const wakeUp = async () => {
    const pending = await findPending(ctx, pageId);
    if (pending.some((p) => p.messages.length > 0)) lastChat = Date.now();
    const fast = pending.filter((x) => x.outbox_pending || (x.script_can_answer && x.can_reply));
    if (Date.now() >= blockedUntil) {
      // Fast lane: the script answers plain replies (and resends a waiting reply) itself, in about a second.
      for (const p of fast) {
        try {
          await answer({ page_id: pageId, psid: p.psid, message_ids: p.messages.length ? p.messages.map((m) => m.id) : ['m_resend'], kind: 'answer' }, ctx);
        } catch (err) {
          if (isMessagingBlocked(err)) {
            blockedUntil = Date.now() + BLOCK_RECHECK_MS;
            log(`Meta has restricted this Page from messaging; replies paused, next try in 6 hours. ${ctx.graph.scrub(String((err as Error).message))}`);
            break;
          }
          log(`fast reply failed, Claude will handle it: ${ctx.graph.scrub(err instanceof Error ? err.message : String(err))}`);
        }
      }
    }
    // One reminder to people who stopped mid-application (no AI; inside Meta's 24-hour window only).
    if (Date.now() >= blockedUntil) {
      const n = await sendNudges(ctx, pageId);
      if (n) log(`sent ${n} reminder(s) to people who stopped mid-application`);
    }
    // Whatever the fast lane did not finish goes to Claude (never while Meta blocks messaging).
    const waiting = (list: typeof pending) => list.filter((p) => p.outbox_pending || p.needs_id_review || p.needs_finalize || (p.can_reply && p.messages.length > 0));
    // What the fast lane answered needs no new read now; the next round picks up anything it left, such as an ID photo.
    const others = waiting(pending).filter((p) => !fast.includes(p));
    const rest = Date.now() < blockedUntil || others.length === 0 ? [] : waiting(fast.length ? await findPending(ctx, pageId) : pending);
    const key = pendingKey(rest);
    again = fast.length > 0 || rest.length > 0;
    if (rest.length > 0 && brake.canRun(key)) {
      log(`${rest.length} chat(s) need Claude; waking Claude`);
      for (const p of rest) if (p.can_reply && p.messages.length > 0) await showTyping(ctx, pageId, p.psid);
      const code = await runClaude();
      const after = pendingKey(waiting(await findPending(ctx, pageId)));
      const wait = brake.done(key, code === 0, after);
      log(`Claude finished (exit ${code})${wait ? `; same chats still waiting, next Claude try in ${wait}s` : ''}`);
    }
  };
  for (;;) {
    try {
      if (check.needsFull(await latestChatTime(ctx, pageId), again)) await wakeUp();
      backoff = Math.max(0, backoff - 5);
    } catch (err) {
      if (err instanceof GraphError && [4, 17, 32, 613, 80001].includes(err.code ?? -1)) {
        backoff = Math.min(backoff ? backoff * 2 : 30, 600);
        log(`Meta says too many calls; slowing down by ${backoff}s`);
      } else log(ctx.graph.scrub(err instanceof Error ? err.message : String(err)));
    }
    const active = Date.now() - lastChat < ctx.cfg.FB_WATCH_ACTIVE_MINUTES * 60_000;
    // Meta reports how much of its call limit is used: slow down well before it stops us.
    const slow = ctx.graph.usagePct >= ctx.cfg.FB_WATCH_SLOW_USAGE_PCT ? ctx.cfg.FB_WATCH_SLOW_EXTRA_SEC : 0;
    const wait = (active ? ctx.cfg.FB_WATCH_ACTIVE_INTERVAL_SEC : ctx.cfg.FB_WATCH_INTERVAL_SEC) + backoff + slow;
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

// Only run when started as a program (tests import operatorPrompt).
if (process.argv[1] && path.resolve(process.argv[1]).replace(/\.ts$/, '.js').endsWith(path.join('dist', 'watch.js'))) {
  main().catch((err) => {
    log(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
