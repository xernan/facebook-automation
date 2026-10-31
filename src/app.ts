import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callTool, tools, type Ctx } from './tools.js';

export const VERSION = '0.2.0';

function formatError(err: unknown, scrub: (s: string) => string): string {
  if (err instanceof z.ZodError) return `Invalid input: ${z.prettifyError(err)}`;
  return scrub(err instanceof Error ? err.message : String(err));
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError } : {}) });

/**
 * Builds the MCP server. If the config cannot load (no .env yet, bad value), the server still
 * starts in setup mode: every tool answers with the setup problem instead of the whole server
 * failing to connect.
 */
export function createServer(loadCtx: () => Ctx): { server: McpServer; ctx?: Ctx; setupError?: string } {
  let ctx: Ctx | undefined;
  let setupError: string | undefined;
  try {
    ctx = loadCtx();
  } catch (err) {
    // Config errors only name keys, never values, so they are safe to show.
    setupError = err instanceof Error ? err.message : String(err);
  }
  const setupHelp = () =>
    `Setup needed: ${setupError}. Fill in .env yourself (see docs/SETUP.md), run "npm run doctor", then restart Claude.`;

  const server = new McpServer({ name: 'facebook-automation', version: VERSION });

  server.registerTool(
    'fb_setup_status',
    {
      description: 'Check whether the Facebook connection is set up (token loaded, writes on/off). Shows no secrets.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      text(
        JSON.stringify(
          ctx
            ? {
                ready: true,
                graph_version: ctx.cfg.FB_GRAPH_VERSION,
                writes_enabled: ctx.cfg.FB_WRITE_ENABLED,
                appsecret_proof: !!ctx.cfg.FB_APP_SECRET,
                token_type: ctx.cfg.FB_USER_ACCESS_TOKEN ? 'user' : 'page',
              }
            : { ready: false, problem: setupHelp() },
          null,
          2,
        ),
      ),
  );

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
        if (!ctx) return text(setupHelp(), true);
        try {
          const result: any = await callTool(def, args, ctx);
          // A tool may return MCP content directly (e.g. ID images for Claude to look at).
          if (Array.isArray(result?.__content)) return { content: result.__content };
          // Scrub results too: a Graph read can return a token (e.g. fields=access_token).
          return text(ctx.graph.scrub(JSON.stringify(result, null, 2)));
        } catch (err) {
          return text(formatError(err, (s) => ctx.graph.scrub(s)), true);
        }
      },
    );
  }

  return { server, ctx, setupError };
}
