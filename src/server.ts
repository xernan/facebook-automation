#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './app.js';
import { createContext } from './context.js';
import { tools } from './tools.js';

async function main() {
  const { server, ctx, setupError } = createServer(createContext);
  await server.connect(new StdioServerTransport());
  // stderr only: stdout is the MCP channel. Never log tokens or lead data.
  if (ctx) {
    console.error(`facebook-automation ready (${tools.length} tools, writes ${ctx.cfg.FB_WRITE_ENABLED ? 'ON' : 'OFF'})`);
  } else {
    console.error(`facebook-automation in setup mode: ${setupError}`);
  }
}

main().catch((err) => {
  console.error(`facebook-automation failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
