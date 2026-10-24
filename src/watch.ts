#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT_DIR, createContext } from './context.js';
import { findPending } from './flowtools.js';

// Watcher: checks the Page's Messenger every FB_WATCH_INTERVAL_SEC without AI. When someone wrote,
// it wakes Claude (headless) with only the flow and messaging tools, and Claude handles the chats.
// Logs go to stderr and never include names, messages or tokens.

const ALLOWED = [...['fb_flow_pending', 'fb_flow_answer', 'fb_flow_id_images', 'fb_flow_id_review', 'fb_lead_finalize', 'fb_send_message', 'fb_get_messages'].map((t) => `mcp__facebook__${t}`), 'WebSearch'];

export function operatorPrompt(pageId: string): string {
  return [
    `You answer Messenger chats for Facebook Page ${pageId} using the application flow tools.`,
    `1. Call fb_flow_pending with page_id ${pageId}.`,
    '2. For each person in the list (skip anyone with can_reply=false, except to resend an outbox_pending reply):',
    '   - outbox_pending: call fb_flow_answer kind="answer" with their message ids; it resends the saved reply first.',
    '   - stage "new", or the messages answer current_question: fb_flow_answer kind="answer" with all their message ids.',
    '   - an off-script question: reply yourself with fb_send_message (recipient_psid), short and friendly in the same',
    '     language they used (Taglish is fine), then repeat current_question in that same message. After it is sent,',
    '     call fb_flow_answer kind="question" with those message ids.',
    '   - reply null (finished, excluded or cooldown): reply yourself only if they asked something.',
    '   - needs_id_review: call fb_flow_id_images, look at every photo, then fb_flow_id_review with one entry per photo',
    '     (type, side, clear, has_signature, and name/birthday/sex only if you can read them). The code decides if the IDs are enough.',
    '   - lead_saved: call fb_lead_finalize with what you read on the IDs and found in public info (split addresses + zip,',
    '     office phone with its source, nature of business, department, employment type). Leave out what you are not sure of.',
    '     Never invent income, TIN, SSS or other personal facts.',
    '   - next_question.wants_suggestions: you may WebSearch public facts for it (e.g. the branch address of the employer',
    '     they named, or its line of business) and pass up to 5 as suggestions to fb_flow_answer. Only facts you found and',
    '     are sure of. If unsure, pass none. Never suggest or guess personal details (names, birthplace, home address,',
    "     mother's maiden name).",
    '3. Never ask for a card number, CVV, OTP, PIN or passwords. Never promise approval, rates or promos.',
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

  const mcpConfig = path.join(tmpdir(), 'facebook-automation-watch-mcp.json');
  writeFileSync(
    mcpConfig,
    JSON.stringify({ mcpServers: { facebook: { command: process.execPath, args: [path.join(ROOT_DIR, 'dist', 'server.js')] } } }),
  );

  const runClaude = () =>
    new Promise<number | null>((resolve) => {
      const child = spawn(
        claudeBin(ctx.cfg.FB_WATCH_CLAUDE_BIN),
        ['-p', operatorPrompt(pageId), '--mcp-config', mcpConfig, '--strict-mcp-config', '--tools', 'WebSearch', '--allowedTools', ALLOWED.join(',')],
        { cwd: ctx.cfg.flowDir, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true },
      );
      const timer = setTimeout(() => {
        log('Claude run took too long; stopped it.');
        child.kill();
      }, ctx.cfg.FB_WATCH_CLAUDE_TIMEOUT_MIN * 60_000);
      child.on('error', (err) => {
        clearTimeout(timer);
        log(`Could not start Claude: ${err.message}`);
        resolve(null);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

  log(`watching every ${ctx.cfg.FB_WATCH_INTERVAL_SEC}s`);
  for (;;) {
    try {
      const pending = await findPending(ctx, pageId);
      const people = pending.filter((p) => p.outbox_pending || (p.can_reply && p.messages.length > 0)).length;
      if (people > 0) {
        log(`${people} chat(s) waiting; waking Claude`);
        const code = await runClaude();
        log(`Claude finished (exit ${code})`);
      }
    } catch (err) {
      log(ctx.graph.scrub(err instanceof Error ? err.message : String(err)));
    }
    await new Promise((r) => setTimeout(r, ctx.cfg.FB_WATCH_INTERVAL_SEC * 1000));
  }
}

// Only run when started as a program (tests import operatorPrompt).
if (process.argv[1] && path.resolve(process.argv[1]).replace(/\.ts$/, '.js').endsWith(path.join('dist', 'watch.js'))) {
  main().catch((err) => {
    log(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
