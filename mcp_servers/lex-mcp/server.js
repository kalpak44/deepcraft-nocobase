// lex-mcp — the tool surface the Lexy AI employee actually sees.
//
// It exists for one blunt reason. Per .claude/rules/nocobase.md, NocoBase
// decides an MCP tool's permission from its raw name: ALLOW if the name starts
// with "get", ASK otherwise. That rule is hardcoded in
// @nocobase/ai/lib/mcp-manager (`rawToolName.startsWith("get") ? "ALLOW" :
// "ASK"`) and the map it fills is in memory only, so it resets on every restart
// of nocobase.service. Every tool upstream's Playwright MCP exposes is called
// browser_something. Wired to NocoBase directly, a law researcher would need a
// human confirmation for every navigate, every snapshot and every click —
// a dozen or more per question, for ever.
//
// So this server sits in front of it and does three things:
//
//   1. Renames. Everything here starts with get_, so NocoBase auto-calls it and
//      keeps auto-calling it after a deploy.
//   2. Curates. browser_evaluate, browser_run_code_unsafe, browser_file_upload
//      and browser_close are NOT re-exposed. The first two are arbitrary code
//      execution; the last would tear down the shared, long-lived browser that
//      the whole Cloudflare design depends on.
//   3. Handles the challenge. Cloudflare cannot be answered from here, so when
//      it appears every tool stops and hands back the takeover URL and the exact
//      steps a person should follow.
//
// Renaming a tool here so that it no longer starts with get_ silently makes it
// ask; adding a get_ tool that writes something silently makes it auto-call.
// Neither is cosmetic.

import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { call, evaluate, UPSTREAM_URL } from './upstream.js';
import {
  allowedUrl, challengeNotice, ENTRY_POINTS, LEX_HOST, READ_PAGE, SEARCH_SCOPES, SUBMIT_SEARCH
} from './page.js';

const PORT = process.env.PORT || 8814;
// Loopback by default: /mcp has no authentication of its own and the only
// client is NocoBase on this same box — same reasoning as ciela-mcp and
// docs-mcp.
const HOST = process.env.HOST || '127.0.0.1';

// Where a person goes to answer a challenge by hand. Configured rather than
// derived: this server has no idea what hostname it is reached by.
const TAKEOVER_URL =
  process.env.BROWSER_TAKEOVER_URL || 'https://ownai.deepcraftstudio.com/browser/';

const DEFAULT_LIMIT = 15000;

// What to tell the employee for each way lex.bg declines to serve a page. The
// common thread is the last sentence of each: none of these means the law is
// absent, and an employee that reports "not found" on the strength of one has
// given a wrong legal answer rather than no answer.
const SITE_PROBLEMS = {
  'php-error':
    'lex.bg returned one of its PHP/database error pages instead of content. The site runs ' +
    'PHP 5.6 and does this intermittently. Open the same URL again, or come at the document ' +
    'from ' + ENTRY_POINTS.laws + '. Do NOT quote anything from this page, and do not tell ' +
    'the user the law does not exist on the basis of it.',
  throttled:
    'lex.bg answered "Please, try later" — it is rate-limiting this browser, not saying the ' +
    'page is missing. Wait a few seconds and open the same URL again, and slow down: fewer, ' +
    'more deliberate page loads. Do not tell the user the law does not exist on the basis ' +
    'of it.',
  thin:
    'lex.bg returned a page with essentially nothing on it and no links, which is never a ' +
    'real legal document — most likely the site failed quietly. Open the same URL again, or ' +
    'navigate to it from ' + ENTRY_POINTS.laws + '. Do not treat this as the law being absent.'
};

const ok = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
});

const fail = (tool, err) => ({
  isError: true,
  content: [{ type: 'text', text: `${tool} error: ${err.message}` }]
});

/**
 * Apply a fixed script to the page with values baked in.
 *
 * The script is a constant from page.js; only the arguments vary, and they are
 * JSON-encoded into it. That keeps model-supplied text as data — a JS string
 * literal — and never as code.
 */
function withArgs(script, ...args) {
  const encoded = args.map((a) => JSON.stringify(a)).join(', ');
  return `() => (${script})(${encoded})`;
}

/** Read the current page, and describe it the way the employee should see it. */
async function readPage({ limit = DEFAULT_LIMIT, offset = 0 } = {}) {
  const page = await evaluate(withArgs(READ_PAGE, limit, offset));

  if (page.challenged) {
    return {
      blocked: true,
      reason: 'cloudflare-challenge',
      url: page.url,
      title: page.title,
      whatToDo: challengeNotice(TAKEOVER_URL, page.url)
    };
  }

  if (page.problem) {
    return {
      blocked: true,
      reason: page.problem,
      url: page.url,
      title: page.title,
      whatToDo: SITE_PROBLEMS[page.problem]
    };
  }

  return {
    blocked: false,
    url: page.url,
    title: page.title,
    // Chrome starts on about:blank and stays wherever the last question left
    // it, so "not on lex.bg" is the normal resting state rather than a fault.
    ...(page.onSite ? {} : { idle: true, note: 'The browser is not on lex.bg yet. Open a page with get_lex_open.' }),
    textLength: page.textLength,
    textOffset: page.textOffset,
    truncated: page.truncated,
    ...(page.truncated
      ? {
          more:
            `Showing characters ${page.textOffset}-${page.textOffset + page.text.length} of ` +
            `${page.textLength}. Call get_lex_page_text with offset ` +
            `${page.textOffset + page.text.length} to continue reading this document.`
        }
      : {}),
    ...(page.noResults ? { note: "lex.bg reported 'Няма резултати от търсенето!' for this search." } : {}),
    text: page.text,
    links: page.links
  };
}

function buildServer() {
  const server = new McpServer({ name: 'lex-mcp', version: '1.0.0' });

  server.registerTool(
    'get_lex_open',
    {
      title: 'Open a page on lex.bg',
      description:
        'Open a URL on lex.bg (' + LEX_HOST + ' only) in the shared research browser and read ' +
        'it. This is the main tool: use it to reach a law, a code, an article or one of the ' +
        'index pages, and use it before answering any question about Bulgarian law.\n\n' +
        'Returns the page URL and title, the page text, and every in-site link on the page ' +
        'with its label and href. Navigate by taking an href from that list and calling this ' +
        'tool again — you do not need a snapshot or an element reference to follow a link.\n\n' +
        'Good entry points, in order of usefulness:\n' +
        '  ' + ENTRY_POINTS.laws + '   — the alphabetical tree of laws (Закони)\n' +
        '  ' + ENTRY_POINTS.codes + '   — the codes (Кодекси)\n' +
        '  ' + ENTRY_POINTS.guide + '   — the portal front page\n' +
        'Individual documents live at https://lex.bg/laws/ldoc/<id>, for example the ' +
        'Constitution is https://lex.bg/laws/ldoc/521957377.\n\n' +
        'Long documents are truncated: check "truncated" and "textLength", and use ' +
        'get_lex_page_text with an offset to read the rest before you quote an article. If ' +
        '"blocked" comes back true, read "whatToDo" and follow it exactly — it means either ' +
        'Cloudflare wants a human or lex.bg served an error page, and in neither case is the ' +
        'text on the page worth anything.',
      inputSchema: {
        url: z
          .string()
          .min(1)
          .describe('The full https://lex.bg/... URL to open. Only lex.bg is permitted.'),
        limit: z
          .number()
          .int()
          .min(500)
          .max(60000)
          .optional()
          .describe(`Characters of page text to return (default ${DEFAULT_LIMIT}).`)
      }
    },
    async ({ url, limit }) => {
      try {
        const check = allowedUrl(url);
        if (!check.ok) return { isError: true, content: [{ type: 'text', text: check.reason }] };
        const { text, isError } = await call('browser_navigate', { url: check.url });
        if (isError) {
          return {
            isError: true,
            content: [{ type: 'text', text: `could not open ${check.url}: ${text.slice(0, 400)}` }]
          };
        }
        return ok(await readPage({ limit }));
      } catch (err) {
        return fail('get_lex_open', err);
      }
    }
  );

  server.registerTool(
    'get_lex_page_text',
    {
      title: 'Read more of the current lex.bg page',
      description:
        'Read a further slice of the text of the page already open in the research browser, ' +
        'without navigating anywhere. Use this when get_lex_open reported "truncated": true, ' +
        'which is normal for a whole law — pass the offset it suggested. Quoting an article ' +
        'you have not actually read because it fell past the truncation point is the single ' +
        'easiest way to get a legal answer wrong.',
      inputSchema: {
        offset: z
          .number()
          .int()
          .min(0)
          .describe('Character offset into the page text to start from.'),
        limit: z
          .number()
          .int()
          .min(500)
          .max(60000)
          .optional()
          .describe(`Characters to return (default ${DEFAULT_LIMIT}).`)
      }
    },
    async ({ offset, limit }) => {
      try {
        return ok(await readPage({ offset, limit }));
      } catch (err) {
        return fail('get_lex_page_text', err);
      }
    }
  );

  server.registerTool(
    'get_lex_search',
    {
      title: "Search lex.bg's own index",
      description:
        "Run a query through lex.bg's site-wide search form.\n\n" +
        'Be warned, and this is measured rather than assumed: this search is poor. It answers ' +
        '"Няма резултати от търсенето!" (no results) for queries as obvious as "Конституция", ' +
        'which is certainly on the site. Treat an empty result as telling you nothing about ' +
        'whether the law exists.\n\n' +
        'Prefer browsing the alphabetical tree at ' + ENTRY_POINTS.laws + ' or the codes at ' +
        ENTRY_POINTS.codes + ' with get_lex_open, where the document titles are listed as ' +
        'plain links. Reach for this tool when you have a distinctive phrase to look for and ' +
        'the trees have not turned it up.',
      inputSchema: {
        query: z.string().min(1).describe('Words to search for, in Bulgarian where possible.'),
        scope: z
          .enum(Object.keys(SEARCH_SCOPES))
          .optional()
          .describe(
            'Which part of the site to search: "acts" for legislation, "all" for everything, ' +
              'also "news" and "forums". Default "acts".'
          )
      }
    },
    async ({ query, scope }) => {
      try {
        // The form only exists on the portal pages, so make sure one is loaded
        // before submitting it.
        await call('browser_navigate', { url: ENTRY_POINTS.guide });
        const before = await readPage({ limit: 500 });
        if (before.blocked) return ok(before);

        const field = SEARCH_SCOPES[scope || 'acts'];
        const submitted = await evaluate(withArgs(SUBMIT_SEARCH, query, field));
        if (!submitted.ok) {
          return {
            isError: true,
            content: [{ type: 'text', text: `could not submit the search: ${submitted.error}` }]
          };
        }
        // The form posts and the browser navigates; wait for the result page
        // rather than reading the page we just left.
        await call('browser_wait_for', { time: 3 });
        return ok({ query, scope: scope || 'acts', ...(await readPage()) });
      } catch (err) {
        return fail('get_lex_search', err);
      }
    }
  );

  server.registerTool(
    'get_lex_snapshot',
    {
      title: 'Inspect the current page structure',
      description:
        'Return the accessibility snapshot of the page currently open, with a [ref=eNN] handle ' +
        'for each element. You only need this when you have to interact with something rather ' +
        'than read it — a cookie banner, a form, a control that is not a link — because ' +
        'get_lex_click and get_lex_type identify elements by those refs. For reading a document ' +
        'or following a link, get_lex_open and get_lex_page_text are cheaper and clearer.',
      inputSchema: {}
    },
    async () => {
      try {
        const { text, isError } = await call('browser_snapshot');
        return isError ? { isError: true, content: [{ type: 'text', text }] }
          : { content: [{ type: 'text', text }] };
      } catch (err) {
        return fail('get_lex_snapshot', err);
      }
    }
  );

  server.registerTool(
    'get_lex_click',
    {
      title: 'Click an element on the current page',
      description:
        'Click an element identified by a [ref=eNN] handle from get_lex_snapshot. Use it to ' +
        'dismiss the cookie consent banner ("Разрешавам бисквитките"), open a collapsed section ' +
        'of a tree, or page through results. To follow an ordinary link, prefer get_lex_open ' +
        'with the href — it does not depend on refs, which change whenever the page does.',
      inputSchema: {
        target: z
          .string()
          .min(1)
          .describe(
            'Either a [ref=eNN] handle from get_lex_snapshot (pass just "e53") or a unique CSS ' +
              'selector. A selector is worth preferring where one exists: refs are renumbered ' +
              'every time the page changes.'
          ),
        element: z
          .string()
          .min(1)
          .describe('Human-readable description of what you are clicking, for the log.')
      }
    },
    async ({ target, element }) => {
      try {
        const { text, isError } = await call('browser_click', { target, element });
        if (isError) return { isError: true, content: [{ type: 'text', text }] };
        return ok(await readPage({ limit: 4000 }));
      } catch (err) {
        return fail('get_lex_click', err);
      }
    }
  );

  server.registerTool(
    'get_lex_type',
    {
      title: 'Type into a field on the current page',
      description:
        'Type text into an input identified by a [ref=eNN] handle from get_lex_snapshot, ' +
        'optionally submitting the form afterwards. get_lex_search already handles the site ' +
        'search box, so this is for the occasional other field.',
      inputSchema: {
        target: z
          .string()
          .min(1)
          .describe(
            'Either a [ref=eNN] handle from get_lex_snapshot (pass just "e53") or a unique CSS ' +
              'selector, for example "input[name=searchBox]".'
          ),
        element: z.string().min(1).describe('Human-readable description of the field.'),
        text: z.string().describe('The text to type.'),
        submit: z
          .boolean()
          .optional()
          .describe('Press Enter afterwards to submit the form. Default false.')
      }
    },
    async ({ target, element, text, submit }) => {
      try {
        const res = await call('browser_type', { target, element, text, submit: Boolean(submit) });
        if (res.isError) return { isError: true, content: [{ type: 'text', text: res.text }] };
        if (submit) await call('browser_wait_for', { time: 3 });
        return ok(await readPage({ limit: 6000 }));
      } catch (err) {
        return fail('get_lex_type', err);
      }
    }
  );

  server.registerTool(
    'get_lex_back',
    {
      title: 'Go back to the previous lex.bg page',
      description:
        'Return to the previous page in the research browser, then read it. Useful after ' +
        'opening a document from a tree and wanting the tree back.',
      inputSchema: {}
    },
    async () => {
      try {
        const { text, isError } = await call('browser_navigate_back');
        if (isError) return { isError: true, content: [{ type: 'text', text }] };
        return ok(await readPage());
      } catch (err) {
        return fail('get_lex_back', err);
      }
    }
  );

  server.registerTool(
    'get_browser_status',
    {
      title: 'Check whether the research browser is usable',
      description:
        'Report what the shared research browser currently has open and whether anything is ' +
        'blocking it — a Cloudflare human-verification challenge, or one of lex.bg\'s error ' +
        'pages.\n\n' +
        'Call this when a page looks wrong, and call it again after you have asked a person to ' +
        'verify a challenge, to confirm they are done before you carry on. If it reports a ' +
        'challenge, follow "whatToDo" exactly: give the user the takeover URL and wait. You ' +
        'cannot solve a challenge yourself, and retrying the same page will not clear it.',
      inputSchema: {}
    },
    async () => {
      try {
        const page = await readPage({ limit: 600 });
        return ok({
          ...page,
          takeoverUrl: TAKEOVER_URL,
          usable: !page.blocked
        });
      } catch (err) {
        return fail('get_browser_status', err);
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  // Stateless per request, exactly like docs-mcp: the state worth keeping is the
  // browser session, and that lives in the upstream client and in Chrome — not
  // here.
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

// Reports whether the whole chain works, not just this process: it asks the page
// what it is, which only answers if playwright-mcp is up and Chrome is attached.
// That makes one curl enough to tell "lex-mcp is dead" from "a challenge is
// waiting for a person" — which is what `just lexy-status` prints.
app.get('/health', async (req, res) => {
  try {
    const page = await readPage({ limit: 200 });
    res.json({
      ok: true,
      upstream: UPSTREAM_URL,
      takeoverUrl: TAKEOVER_URL,
      browser: {
        url: page.url,
        title: page.title,
        usable: !page.blocked,
        ...(page.blocked ? { blockedBy: page.reason } : {}),
        ...(page.idle ? { idle: true } : {})
      }
    });
  } catch (err) {
    res.status(503).json({ ok: false, upstream: UPSTREAM_URL, error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(
    `lex-mcp listening on ${HOST}:${PORT}, MCP endpoint at /mcp, ` +
      `upstream ${UPSTREAM_URL}, takeover ${TAKEOVER_URL}`
  );
});