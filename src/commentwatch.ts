#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findPendingComments } from './comments.js';
import { ROOT_DIR, createContext } from './context.js';
import { GraphError } from './graph.js';
import { ClaudeBrake, takeLock } from './watchguard.js';

// Comment watcher: every FB_COMMENT_INTERVAL_SEC it looks for people's new comments on our recent posts (no AI).
// When some are ready (older than FB_COMMENT_MIN_DELAY_SEC) and the hourly limit allows, it wakes Claude with
// only the two comment tools. Limits and the rule check live in src/comments.ts. Logs never include names or text.

const ALLOWED = ['fb_comment_pending', 'fb_comment_answer'].map((t) => `mcp__facebook__${t}`);

export function commentPrompt(pageId: string): string {
  return [
    `You reply to comments on Facebook Page ${pageId} (CARD MAX: free help applying for another credit card, for people who already have one).`,
    `1. Call fb_comment_pending with page_id ${pageId}. Handle only comments with ready=true, oldest first, while replies_left_this_hour > 0.`,
    '2. For each comment, call fb_comment_answer once:',
    '   - A question or an answer to the post: action="reply". Write it in English, the way a friendly person who runs the Page',
    '     would type it on a phone. 1-2 short sentences. Answer what THEY said; add a short follow-up question only when it fits.',
    '   - They ask how to apply or want help: reply publicly (e.g. "Sent you a message!") and add private_message: a short note',
    '     that we can help them apply for free if they already have a credit card, and they can reply there to start.',
    '   - Now and then (not every time) a casual "Follow us for more card tips" is fine.',
    '   - Spam, rude, scam-looking, political, or no words: action="skip".',
    "   Sound human, not like AI: plain everyday words and contractions (you're, it's); no \"Great question!\", \"Absolutely!\",",
    "   \"We're thrilled\", \"Feel free to\", \"Hope this helps\", \"Don't hesitate\"; no dashes, bullet lists, hashtags or sign-offs;",
    '   at most one emoji, often none; use their first name only sometimes; start each reply differently. Never say you are a bot',
    '   or AI, and never pretend to be a specific named person.',
    '3. Rules (the code refuses breaking them): never promise approval, limits, rates or promos; the bank decides. Never ask for',
    '   or mention card numbers, CVV, OTP, PIN, passwords, or any personal details in public. Never ask people to like, share,',
    '   tag or vote. No links. If you do not know, say the team will help in Messenger.',
    '4. Stop when there are no ready comments or no replies left this hour. Do nothing else.',
  ].join('\n');
}

function claudeBin(configured?: string): string {
  if (configured) return configured;
  const exe = path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return process.platform === 'win32' && existsSync(exe) ? exe : 'claude';
}

const log = (m: string) => console.error(`[comments ${new Date().toISOString()}] ${m}`);

async function main() {
  const ctx = createContext();
  const pageId = ctx.cfg.FB_FLOW_PAGE_ID;
  if (!pageId) throw new Error('Set FB_FLOW_PAGE_ID in .env.');
  if (!ctx.cfg.FB_WRITE_ENABLED) throw new Error('FB_WRITE_ENABLED must be true to reply.');
  if (!ctx.cfg.FB_COMMENTS_LIVE) throw new Error('Comment replies are off (FB_COMMENTS_LIVE). Owner turns them on.');

  const mcpConfig = path.join(tmpdir(), 'facebook-automation-comments-mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { facebook: { command: process.execPath, args: [path.join(ROOT_DIR, 'dist', 'server.js')] } } }));
  const runClaude = () =>
    new Promise<number | null>((resolve) => {
      const child = spawn(
        claudeBin(ctx.cfg.FB_WATCH_CLAUDE_BIN),
        ['-p', commentPrompt(pageId), '--mcp-config', mcpConfig, '--strict-mcp-config', '--tools', '', '--allowedTools', ALLOWED.join(',')],
        { cwd: ctx.cfg.flowDir, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true },
      );
      const timer = setTimeout(() => child.kill(), ctx.cfg.FB_WATCH_CLAUDE_TIMEOUT_MIN * 60_000);
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

  const brake = new ClaudeBrake();
  const release = takeLock(ctx.cfg.flowDir, process.pid, 'comments.lock');
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.once(sig, () => {
      release();
      process.kill(process.pid, sig);
    });
  let backoff = 0;
  log(`checking comments every ${ctx.cfg.FB_COMMENT_INTERVAL_SEC}s`);
  for (;;) {
    try {
      const { comments, replies_left_this_hour } = await findPendingComments(ctx, pageId);
      const ready = comments.filter((c) => c.ready);
      const key = ready.map((c) => c.comment_id).join(',');
      if (ready.length && replies_left_this_hour > 0 && brake.canRun(key)) {
        log(`${ready.length} comment(s) ready; waking Claude`);
        const code = await runClaude();
        const after = (await findPendingComments(ctx, pageId)).comments.filter((c) => c.ready).map((c) => c.comment_id).join(',');
        const wait = brake.done(key, code === 0, after);
        log(`Claude finished (exit ${code})${wait ? `; same comments still waiting, next try in ${wait}s` : ''}`);
      }
      backoff = Math.max(0, backoff - 30);
    } catch (err) {
      if (err instanceof GraphError && [4, 17, 32, 613, 80001, 368].includes(err.code ?? -1)) {
        backoff = Math.min(backoff ? backoff * 2 : 300, 21_600);
        log(`Meta says slow down (code ${err.code}); waiting ${backoff}s more`);
      } else log(ctx.graph.scrub(err instanceof Error ? err.message : String(err)));
    }
    await new Promise((r) => setTimeout(r, (ctx.cfg.FB_COMMENT_INTERVAL_SEC + backoff) * 1000));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).replace(/\.ts$/, '.js').endsWith(path.join('dist', 'commentwatch.js'))) {
  main().catch((err) => {
    log(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
