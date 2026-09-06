import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { search, getDocument } from './cielaClient.js';

const PORT = process.env.PORT || 8811;
// Loopback by default: /mcp has no authentication of its own, and the only
// client is NocoBase on the same box. Override only with something in front.
const HOST = process.env.HOST || '127.0.0.1';

function buildServer() {
  const server = new McpServer({ name: 'ciela-mcp', version: '1.0.0' });

  server.registerTool(
    'ciela_search',
    {
      title: 'Search Ciela',
      description:
        "Search the Ciela Bulgarian legislation database (web7.ciela.net) by full-text relevance. " +
        "Use this tool whenever the user's request refers to Ciela in ANY form -- including Bulgarian " +
        "spellings/transliterations and misspellings such as \"Сиела\", \"сиела\", \"Циела\", \"циела\", " +
        "\"Siela\", \"siela\", \"Ciela\", \"ciela\" -- or otherwise asks to look up, find, or quote a " +
        "Bulgarian law, court decision, interpretive case, or other legal document. Do not require the " +
        "user to say the exact word \"Ciela\" in Latin script -- recognize the intent from context " +
        "(e.g. \"look this up in Сиела\", \"provera v siela\", \"what does Bulgarian law say about X\"). " +
        "Ranks exact/near-exact phrase matches highest -- pass the complete document title or citation " +
        "when you have one, rather than a vague short phrase. Returns up to `limit` matches (default 25, " +
        "max 100) with title, date, relevance score, a contentHref to pass into ciela_get_document, and " +
        "a citationUrl. For broad or complex research (e.g. surveying case law on a topic, comparing " +
        "multiple decisions), pass a higher limit (e.g. 50-100) to avoid missing relevant results. " +
        "ALWAYS include the citationUrl as the source link when you report a result to the user -- " +
        "never present Ciela content without citing the citationUrl it came from.",
      inputSchema: {
        query: z.string().describe('Search phrase, ideally the full document title or citation'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Max results to return (default 25, max 100 -- use a higher value for broad/complex research)')
      }
    },
    async ({ query, limit }) => {
      try {
        const { totalCount, results } = await search(query, limit ?? 25);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ totalCount, results }, null, 2)
            }
          ]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `ciela_search error: ${err.message}` }]
        };
      }
    }
  );

  server.registerTool(
    'ciela_get_document',
    {
      title: 'Get Ciela document text',
      description:
        'Fetch the full plain text of a Ciela document, given the contentHref returned by ciela_search. ' +
        'Returns the document title, its citationUrl (the source link -- ALWAYS include this when you ' +
        'quote or summarize the document for the user), and its full text extracted from the source HTML.',
      inputSchema: {
        contentHref: z.string().describe('The contentHref field from a ciela_search result')
      }
    },
    async ({ contentHref }) => {
      try {
        const { title, text } = await getDocument(contentHref);
        return {
          content: [{ type: 'text', text: JSON.stringify({ title, text }, null, 2) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `ciela_get_document error: ${err.message}` }]
        };
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  // stateless mode: a fresh server+transport per request, no session persistence needed
  // at the MCP protocol level -- our Ciela auth token is cached at module scope in cielaClient.js
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal error' });
    }
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, HOST, () => {
  console.log(`ciela-mcp listening on ${HOST}:${PORT}, MCP endpoint at /mcp`);
});
