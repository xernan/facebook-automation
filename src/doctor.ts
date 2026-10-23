// `npm run doctor`: checks .env and the token without printing any secret.
import { createContext } from './context.js';

// Use process.exitCode, never the exit call: exiting while fetch sockets are open crashes Node on Windows.
async function main() {
  const ctx = createContext();
  console.log(`Graph API version: ${ctx.cfg.FB_GRAPH_VERSION}`);
  console.log(`Writes enabled:    ${ctx.cfg.FB_WRITE_ENABLED}`);
  console.log(`appsecret_proof:   ${ctx.cfg.FB_APP_SECRET ? 'on' : 'off (set FB_APP_SECRET to turn on)'}`);

  const perms = await ctx.graph.checkPermissions();
  if (perms) {
    console.log(`Permissions OK:    ${perms.granted.join(', ') || '(none)'}`);
    if (perms.missing.length) {
      console.log(`Permissions MISSING (add them, then make a new token): ${perms.missing.join(', ')}`);
    }
  }

  const pages = await ctx.graph.listPages();
  if (pages.length === 0) {
    console.log(
      perms?.granted.includes('pages_show_list')
        ? 'Token works, but no Page was shared with it. Make a new token and tick your Page in the "Choose Pages" step.'
        : 'Token works, but it manages no Pages. Add the pages_show_list permission and make a new token.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Pages this token manages (${pages.length}):`);
  for (const p of pages) console.log(`  ${p.id}  ${p.name}  [${(p.tasks ?? []).join(', ')}]`);
  if (perms?.missing.length) {
    console.log('Partly OK: some tools will fail until the missing permissions are added.');
    process.exitCode = 1;
    return;
  }
  console.log('OK');
}

main().catch((err) => {
  console.error(`Doctor failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
