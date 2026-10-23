#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createContext } from './context.js';
import { callTool, tools } from './tools.js';

function formatError(err: unknown, scrub: (s: string) => string): string {
  if (err instanceof z.ZodError) return `Invalid input: ${z.prettifyError(err)}`;
  return scrub(err instanceof Error ? err.message : String(err));
}

async function main() {
  const ctx = createContext();
  const server = new McpServer({ name: 'facebook-automation', version: '0.1.0' });

  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        description: def.write ? `[WRITE] ${def.description}` : def.description,
        inputSchema: def.input,
        annotations: {
          readOnlyHint: !def.write,
          destructiveHint: def.name.includes('delete'),
          openWorldHint: true,
        },
      },
      async (args: unknown) => {
        try {
          const result = await callTool(def, args, ctx);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: formatError(err, (s) => ctx.graph.scrub(s)) }], isError: true };
        }
      },
    );
  }

  await server.connect(new StdioServerTransport());
  // stderr only: stdout is the MCP channel. Never log tokens or lead data.
  console.error(`facebook-automation ready (${tools.length} tools, writes ${ctx.cfg.FB_WRITE_ENABLED ? 'ON' : 'OFF'})`);
}

main().catch((err) => {
  console.error(`facebook-automation failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
