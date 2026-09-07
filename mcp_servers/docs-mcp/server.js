// docs-mcp — research and authoring over the WebDAV share at /data/webdav.
//
// The tool names carry the permission model, which is the one piece of this
// worth reading before changing a name. Per .claude/rules/nocobase.md, NocoBase
// defaults an MCP tool's permission to ASK unless its raw name starts with
// "get", and those permissions are in-memory only — every restart of
// nocobase.service resets whatever was set in the UI.
//
// So the split here is deliberate and it is not cosmetic:
//
//   get_documents, get_document_search, get_document_text
//       read-only, auto-call, and stay that way across a deploy.
//   write_document, edit_document
//       NOT named get_*, so NocoBase asks before every single call and keeps
//       asking after a restart. These change files that people rely on and
//       there is no undo, so the confirmation is the feature.
//
// Renaming a write tool to get_something would silently make it auto-call. Do
// not.

import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SUPPORTED } from './extract.js';
import { modelInfo } from './embed.js';
import { createDocument, editDocument, EDITABLE, WRITABLE } from './write.js';
import {
  documentText, listDocuments, ensureFresh, reindexOne, resolveInShare, scan, search, stats, ROOT
} from './store.js';
import path from 'node:path';

const PORT = process.env.PORT || 8812;
// Loopback by default: /mcp has no authentication of its own and the only
// client is NocoBase on this same box — same reasoning as ciela-mcp.
const HOST = process.env.HOST || '127.0.0.1';

const ok = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
});

const fail = (tool, err) => ({
  isError: true,
  content: [{ type: 'text', text: `${tool} error: ${err.message}` }]
});

const FORMATS = SUPPORTED.map((e) => `.${e}`).join(' ');

function buildServer() {
  const server = new McpServer({ name: 'docs-mcp', version: '1.0.0' });

  server.registerTool(
    'get_document_search',
    {
      title: 'Search the shared documents',
      description:
        'Search the shared document library (the team WebDAV share) for passages relevant to a ' +
        'question, across ' + FORMATS + ' files. This is the tool to reach for whenever the user ' +
        'asks what the documents, files, contracts, reports, spreadsheets or "the share" say about ' +
        'something -- use it before answering from memory. Runs a hybrid search: exact keyword ' +
        'matching (good for names, figures, clause numbers, invoice ids) fused with semantic ' +
        'matching (good for questions phrased differently from the document, and it works across ' +
        'languages, so an English question can find Bulgarian or Russian text). Returns the best ' +
        'matching documents, each with its path and up to three excerpts showing why it matched. ' +
        'The excerpts are short: once a document looks right, call get_document_text with its path ' +
        'to read the surrounding text before you quote or summarise it. Always tell the user which ' +
        'file an answer came from, by path.\n\n' +
        'Judging the results: each match carries a "similarity" between 0 and 1 from the semantic ' +
        'half. On this corpus a genuine match scores about 0.85 and above, a weak one 0.78 to 0.85, ' +
        'and anything below about 0.78 is usually unrelated -- the scale is compressed, so 0.76 is ' +
        'a poor match and not a middling one. A match whose matchedBy is "keyword+semantic" found ' +
        'the query both ways and is the strongest signal available. If every result looks weak, say ' +
        'so and offer to search different terms rather than reporting the best of a bad set as if ' +
        'it answered the question.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('What to look for. A natural-language question works as well as keywords.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe('Maximum documents to return (default 8).'),
        mode: z
          .enum(['hybrid', 'keyword', 'semantic'])
          .optional()
          .describe(
            'Default hybrid, which is almost always right. "keyword" for an exact string such as ' +
            'a reference number or a surname; "semantic" for a vague conceptual question.'
          ),
        prefix: z
          .string()
          .optional()
          .describe('Restrict the search to a subfolder of the share, e.g. "contracts/2025".'),
        minSimilarity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            'Drop semantic matches below this similarity (default 0.72, which only removes obvious ' +
            'noise). Raise to about 0.82 when a first search came back with plausible-looking but ' +
            'irrelevant documents.'
          )
      }
    },
    async ({ query, limit, mode, prefix, minSimilarity }) => {
      try {
        return ok(await search({
          query,
          limit: limit ?? 8,
          mode: mode ?? 'hybrid',
          prefix: prefix ?? '',
          ...(minSimilarity === undefined ? {} : { minSimilarity })
        }));
      } catch (err) {
        return fail('get_document_search', err);
      }
    }
  );

  server.registerTool(
    'get_document_text',
    {
      title: 'Read a shared document',
      description:
        'Read the extracted plain text of one document on the shared WebDAV share, given its path ' +
        'exactly as get_document_search or get_documents reported it. Handles ' + FORMATS + ': PDFs ' +
        'keep their page layout, spreadsheets come back as tab-separated rows under a "--- Sheet: ' +
        'name ---" heading per sheet, and presentations are split by slide. Long documents are ' +
        'returned in slices -- check totalChars and hasMore in the response, and call again with a ' +
        'larger offset to continue reading rather than assuming you have seen the whole file. Use ' +
        'this to get the exact wording before quoting, and quote what the document says rather than ' +
        'paraphrasing from the search excerpt alone.',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe('Path relative to the share, e.g. "contracts/acme-2025.pdf".'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Character offset to start from (default 0). Use it to page through a long file.'),
        limit: z
          .number()
          .int()
          .min(500)
          .max(200_000)
          .optional()
          .describe('Characters to return (default 40000).')
      }
    },
    async ({ path: rel, offset, limit }) => {
      try {
        await ensureFresh();
        return ok(documentText(rel, offset ?? 0, limit ?? 40_000));
      } catch (err) {
        return fail('get_document_text', err);
      }
    }
  );

  server.registerTool(
    'get_documents',
    {
      title: 'List the shared documents',
      description:
        'List what is currently on the shared WebDAV share, with each file\'s path, format, size, ' +
        'modification time and extracted length. Use it to answer "what documents do we have", to ' +
        'find recently added files, or to scope a search to a subfolder. It also reports, per file, ' +
        'whether the text could be extracted: a file with an "error" cannot be searched or read, and ' +
        'the message says why -- most often a scanned PDF with no text layer, which would need OCR. ' +
        'For finding the document that answers a question, prefer get_document_search; this tool is ' +
        'for inventory, not for research.',
      inputSchema: {
        prefix: z
          .string()
          .optional()
          .describe('Only list files under this subfolder of the share, e.g. "invoices/".'),
        ext: z
          .string()
          .optional()
          .describe('Only list one format, e.g. "pdf" or "xlsx".'),
        refresh: z
          .boolean()
          .optional()
          .describe(
            'Force a re-scan of the share before listing. The share is re-scanned automatically ' +
            'about once a minute, so this is only needed when a file was uploaded seconds ago.'
          )
      }
    },
    async ({ prefix, ext, refresh }) => {
      try {
        await (refresh ? scan({ force: true }) : ensureFresh());
        const files = listDocuments({ prefix: prefix ?? '', ext: ext ?? null });
        return ok({
          share: ROOT,
          count: files.length,
          unreadable: files.filter((f) => f.error).length,
          files: files.map((f) => ({
            path: f.path,
            ext: f.ext,
            bytes: f.size,
            modified: new Date(f.mtime).toISOString(),
            chars: f.chars,
            searchable: !f.error,
            ...(f.error ? { error: f.error } : {})
          }))
        });
      } catch (err) {
        return fail('get_documents', err);
      }
    }
  );

  // ── Writing ───────────────────────────────────────────────────────────────
  // Everything below changes the share. See the note at the top of this file
  // about why none of these are named get_*.

  server.registerTool(
    'write_document',
    {
      title: 'Create a document on the share',
      description:
        'Create a new document on the shared WebDAV share, or replace one whole. Writable formats: ' +
        WRITABLE.map((e) => `.${e}`).join(' ') + '.\n\n' +
        'A .docx is generated as a real Word document and a .xlsx as a real Excel workbook -- for ' +
        'a spreadsheet, pass either "rows" as an array of arrays, or "content" as tab- or ' +
        'comma-separated lines, and values that look numeric are written as numbers so Excel can ' +
        'total them. The text formats are written exactly as given.\n\n' +
        'Cannot write .pdf, .doc, .xls or .ppt: authoring those needs a converter that is not ' +
        'installed on this box. If the user asks for a PDF, offer a .docx instead and say why.\n\n' +
        'An existing file is never replaced unless overwrite is true, and a replacement discards ' +
        'the previous content and all of its formatting. Prefer edit_document when the user wants ' +
        'to change part of a document -- that keeps the layout, fonts and images intact. Read the ' +
        'file with get_document_text before overwriting it, so you can tell the user what is being ' +
        'lost.',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Path relative to the share, including the extension, e.g. "reports/q1-summary.docx". ' +
            'Missing folders are created.'
          ),
        content: z
          .string()
          .optional()
          .describe(
            'The document text. For .docx a blank line starts a new paragraph. For .xlsx, tab- or ' +
            'comma-separated lines, one row each, unless "rows" is given instead.'
          ),
        rows: z
          .array(z.array(z.union([z.string(), z.number()])))
          .optional()
          .describe('Spreadsheet rows as an array of arrays. Takes precedence over content for .xlsx.'),
        sheetName: z.string().optional().describe('Sheet name for a new .xlsx (default "Sheet1").'),
        overwrite: z
          .boolean()
          .optional()
          .describe('Replace the file if it already exists (default false, which fails instead).')
      }
    },
    async ({ path: rel, content, rows, sheetName, overwrite }) => {
      try {
        const abs = resolveInShare(rel);
        const ext = path.extname(abs).slice(1).toLowerCase();
        const result = await createDocument({
          abs, ext, content, rows, sheetName, overwrite: overwrite ?? false
        });
        // Straight back into the index, so the next search sees it.
        const indexed = await reindexOne(rel);
        return ok({
          path: indexed.path,
          created: !result.replaced,
          replaced: result.replaced,
          bytes: result.bytes,
          indexed: indexed.status,
          ...(indexed.error ? { indexWarning: indexed.error } : {})
        });
      } catch (err) {
        return fail('write_document', err);
      }
    }
  );

  server.registerTool(
    'edit_document',
    {
      title: 'Edit a document on the share',
      description:
        'Change part of an existing document on the shared WebDAV share, keeping the rest of it as ' +
        'it was. Editable formats: ' + EDITABLE.map((e) => `.${e}`).join(' ') + '.\n\n' +
        'Two operations. Give "find" and "replace" to substitute text -- in a .docx, .xlsx or ' +
        '.pptx the substitution happens inside the document\'s text, so fonts, tables, images and ' +
        'styling all survive. Or give "append" to add text to the end, which works on the plain ' +
        'text formats only.\n\n' +
        'Always call get_document_text first and copy the "find" string from what it returned. ' +
        'Word and Excel split text at every formatting change, so a phrase that spans a bold or ' +
        'coloured word does not exist as one string in the file and cannot be matched -- if a find ' +
        'fails, try a shorter fragment. Pass expectedCount when you know how many occurrences ' +
        'should change, and the edit will abort rather than change more of the document than you ' +
        'intended. The response reports how many replacements were made; tell the user that number ' +
        'and which file, because there is no undo.',
      inputSchema: {
        path: z.string().min(1).describe('Path relative to the share, e.g. "contracts/acme.docx".'),
        find: z
          .string()
          .optional()
          .describe('Exact text to find, copied from get_document_text output. Required unless appending.'),
        replace: z
          .string()
          .optional()
          .describe('Replacement text. Omit or pass an empty string to delete the found text.'),
        append: z
          .string()
          .optional()
          .describe('Text to add at the end of the file instead of replacing. Plain text formats only.'),
        expectedCount: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Abort unless exactly this many occurrences are found.')
      }
    },
    async ({ path: rel, find, replace, append, expectedCount }) => {
      try {
        const abs = resolveInShare(rel);
        const ext = path.extname(abs).slice(1).toLowerCase();
        const result = await editDocument({ abs, ext, find, replace, append, expectedCount });
        const indexed = await reindexOne(rel);
        return ok({
          path: indexed.path,
          ...result,
          indexed: indexed.status,
          ...(indexed.error ? { indexWarning: indexed.error } : {})
        });
      } catch (err) {
        return fail('edit_document', err);
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  // Stateless, one server and transport per request — the index in store.js is
  // module scope and shared, so there is no per-session state worth keeping.
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

// Reports the index rather than just liveness, so the role's verification and
// anyone debugging can tell "indexing 40 documents" from "listening at an empty
// share". Deliberately does not load the embedding model: /health must stay
// cheap enough to poll.
app.get('/health', (req, res) => {
  try {
    res.json({ ok: true, embeddings: modelInfo(), ...stats() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`docs-mcp listening on ${HOST}:${PORT}, MCP endpoint at /mcp, share ${ROOT}`);
  // First walk in the background: a cold start must not block the port, and the
  // first search would otherwise pay for the whole share.
  scan({ force: true })
    .then((c) => c && console.log(`docs-mcp: initial scan ${JSON.stringify(c)}`))
    .catch((err) => console.error(`docs-mcp: initial scan failed: ${err.message}`));
});