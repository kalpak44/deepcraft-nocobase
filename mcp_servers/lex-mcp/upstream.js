// The MCP client half of lex-mcp: one long-lived session to the Playwright MCP
// server, which is itself attached over CDP to the browser role's Chrome.
//
// Why a client at all, rather than driving Chrome directly with playwright-core:
// keeping upstream's server in the path means the browser tools stay upstream's
// — their behaviour, their fixes, their snapshot format — and this file stays a
// transport concern. What lex-mcp adds is naming, curation and the challenge
// flow, not browser automation of its own.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const UPSTREAM_URL = process.env.PLAYWRIGHT_MCP_URL || 'http://127.0.0.1:8813/mcp';

// One session, reused. Playwright MCP is started with --shared-browser-context,
// so every session lands in the same browser context anyway — but reusing one
// client also keeps the same *tab*, which is what makes a sequence of calls read
// like one browsing session instead of a series of unrelated ones.
let client = null;
let pending = null;

async function connect() {
  const c = new Client({ name: 'lex-mcp', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(UPSTREAM_URL));
  await c.connect(transport);
  // A dropped connection must not leave a dead client cached — playwright-mcp
  // restarts on deploy, and the next call has to be able to rebuild the session
  // rather than failing forever.
  c.onclose = () => {
    if (client === c) client = null;
  };
  return c;
}

async function session() {
  if (client) return client;
  // Collapse concurrent first calls onto one handshake.
  if (!pending) {
    pending = connect()
      .then((c) => {
        client = c;
        return c;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

/** Flatten an MCP tool result down to the text it carries. */
function textOf(result) {
  return (result?.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Call a tool on the Playwright MCP server.
 *
 * Retries once on a transport failure, because the common cause is that
 * playwright-mcp was restarted by a deploy since the last call — reconnecting is
 * the correct response, and surfacing "connection closed" to the AI employee
 * would not be.
 */
export async function call(name, args = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = await session();
    try {
      const result = await c.callTool({ name, arguments: args });
      return { text: textOf(result), isError: Boolean(result?.isError) };
    } catch (err) {
      if (client === c) client = null;
      if (attempt === 1) {
        throw new Error(
          `playwright-mcp at ${UPSTREAM_URL} did not answer: ${err.message}. ` +
            'Check: systemctl status playwright-mcp browser-chrome'
        );
      }
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new Error('unreachable');
}

/**
 * Run a fixed script in the page and parse its JSON result.
 *
 * The scripts that reach here are constants in this repository, never anything
 * an AI employee supplied — browser_evaluate is deliberately not among the tools
 * lex-mcp re-exposes. That asymmetry is the point of having a proxy: it can use
 * a sharp primitive internally while the employee only ever sees the blunt ones.
 */
export async function evaluate(fn) {
  const { text, isError } = await call('browser_evaluate', { function: fn });
  if (isError) throw new Error(`browser_evaluate failed: ${text.slice(0, 300)}`);
  // Upstream wraps the return value in a "### Result" section, as a JSON string
  // literal, followed by the code it ran and a page summary. Take the first
  // balanced JSON string out of the Result block rather than parsing the report.
  const match = text.match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/);
  if (!match) throw new Error(`unexpected browser_evaluate response: ${text.slice(0, 300)}`);
  const raw = match[1].trim();
  // The value comes back JSON-encoded; our scripts all return a JSON string, so
  // this is a double decode.
  const inner = JSON.parse(raw);
  return typeof inner === 'string' ? JSON.parse(inner) : inner;
}