// `npm run doctor`: checks .env and the token without printing any secret.
import { createContext } from './context.js';

async function main() {
  const ctx = createContext();
  console.log(`Graph API version: ${ctx.cfg.FB_GRAPH_VERSION}`);
  console.log(`Writes enabled:    ${ctx.cfg.FB_WRITE_ENABLED}`);
  console.log(`appsecret_proof:   ${ctx.cfg.FB_APP_SECRET ? 'on' : 'off (set FB_APP_SECRET to turn on)'}`);
  const pages = await ctx.graph.listPages();
  if (pages.length === 0) {
    console.log('Token works, but it manages no Pages. Check pages_show_list permission and Page access.');
    process.exit(1);
  }
  console.log(`Pages this token manages (${pages.length}):`);
  for (const p of pages) console.log(`  ${p.id}  ${p.name}  [${(p.tasks ?? []).join(', ')}]`);
  console.log('OK');
}

main().catch((err) => {
  console.error(`Doctor failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
