// Exercises every tool against a running docs-mcp, the way NocoBase does:
// over MCP rather than by importing the modules, so the transport, the schemas
// and the tool names are all covered.
//
// It writes to the share, so point it at a scratch directory rather than the
// real one unless you mean it:
//
//   DOCS_MCP_URL=http://127.0.0.1:8812/mcp node test_client.js
//
// Everything it creates is under a docs-mcp-selftest/ folder and removed at the
// end, except when a check fails — then it is left in place to look at.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL_ = process.env.DOCS_MCP_URL || 'http://127.0.0.1:8812/mcp';
const DIR = 'docs-mcp-selftest';

const client = new Client({ name: 'docs-mcp-test', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(URL_)));

let failures = 0;
const check = (label, condition, detail = '') => {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
};

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  if (res.isError) return { error: text };
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log('\nTOOLS:', tools.join(' '));
check('three read tools are named get_*', tools.filter((t) => t.startsWith('get_')).length === 3);
check(
  'no write tool is named get_*',
  ['write_document', 'edit_document'].every((t) => tools.includes(t) && !t.startsWith('get_')),
  'otherwise NocoBase would auto-call them'
);

console.log('\n--- write_document ---');
const md = await call('write_document', {
  path: `${DIR}/notes.md`,
  content: '# Selftest\n\nThe quarterly review is scheduled for March.\n'
});
check('creates a markdown file', md.created === true && md.indexed === 'indexed', JSON.stringify(md));

const dup = await call('write_document', { path: `${DIR}/notes.md`, content: 'x' });
check('refuses to clobber without overwrite', !!dup.error, dup.error?.slice(0, 60));

const docx = await call('write_document', {
  path: `${DIR}/report.docx`,
  content: 'Annual Report\n\nRevenue grew by 12% in the Sofia office.\n\nSigned by Иван Петров.'
});
check('creates a docx', docx.created === true, JSON.stringify(docx));

const xlsx = await call('write_document', {
  path: `${DIR}/figures.xlsx`,
  sheetName: 'Q1',
  rows: [['Client', 'Amount'], ['ACME Ltd', 1499.5], ['Globex', 230]]
});
check('creates an xlsx', xlsx.created === true, JSON.stringify(xlsx));

const pdf = await call('write_document', { path: `${DIR}/nope.pdf`, content: 'x' });
check('refuses to author a pdf', !!pdf.error, pdf.error?.slice(0, 80));

console.log('\n--- get_document_text: round-trips what was written ---');
const docxText = await call('get_document_text', { path: `${DIR}/report.docx` });
check('docx text survives the round trip', docxText.text?.includes('Revenue grew by 12%'));
check('docx keeps non-latin text', docxText.text?.includes('Иван Петров'));
const xlsxText = await call('get_document_text', { path: `${DIR}/figures.xlsx` });
check('xlsx keeps its sheet name', xlsxText.text?.includes('--- Sheet: Q1 ---'), xlsxText.text?.slice(0, 60));
check('xlsx keeps rows and columns', xlsxText.text?.includes('ACME Ltd\t1499.5'), xlsxText.text?.slice(0, 120));

console.log('\n--- edit_document ---');
const edit = await call('edit_document', {
  path: `${DIR}/report.docx`,
  find: 'Revenue grew by 12%',
  replace: 'Revenue grew by 18%',
  expectedCount: 1
});
check('replaces text inside a docx', edit.replacements === 1, JSON.stringify(edit));
const edited = await call('get_document_text', { path: `${DIR}/report.docx` });
check('the docx now reads 18%', edited.text?.includes('18%') && !edited.text?.includes('12%'));

const miscount = await call('edit_document', {
  path: `${DIR}/notes.md`, find: 'quarterly', replace: 'monthly', expectedCount: 5
});
check('aborts on an expectedCount mismatch', !!miscount.error, miscount.error?.slice(0, 70));
const stillThere = await call('get_document_text', { path: `${DIR}/notes.md` });
check('and changed nothing', stillThere.text?.includes('quarterly'));

const appended = await call('edit_document', { path: `${DIR}/notes.md`, append: 'Added by the selftest.' });
check('appends to a text file', appended.operation === 'append', JSON.stringify(appended));

const missing = await call('edit_document', { path: `${DIR}/report.docx`, find: 'not in this document' });
check('reports a find that matches nothing', !!missing.error, missing.error?.slice(0, 60));

console.log('\n--- search ---');
const kw = await call('get_document_search', { query: 'Globex', mode: 'keyword', prefix: DIR });
check('keyword search finds the spreadsheet', kw.results?.[0]?.path === `${DIR}/figures.xlsx`, JSON.stringify(kw.results?.map((r) => r.path)));
const sem = await call('get_document_search', { query: 'when is the review happening?', mode: 'semantic', prefix: DIR });
check('semantic search reports a similarity', typeof sem.results?.[0]?.matches?.[0]?.similarity === 'number');
check('semantic search is available', sem.semanticAvailable === true);

console.log('\n--- get_documents ---');
const list = await call('get_documents', { prefix: DIR, refresh: true });
check('lists what was written', list.count === 3, `count=${list.count} ${JSON.stringify(list.files?.map((f) => f.path))}`);
check('none of it is unreadable', list.unreadable === 0);

console.log('\n--- path confinement ---');
const escape = await call('write_document', { path: '../../../tmp/escaped.txt', content: 'x' });
check('refuses to write outside the share', !!escape.error, escape.error?.slice(0, 60));

if (failures === 0) {
  console.log('\n--- cleanup ---');
  // There is no delete tool on purpose, so the selftest tidies up over the
  // filesystem. Left behind on failure, so there is something to inspect.
  const { rm } = await import('node:fs/promises');
  const share = process.env.DOCS_MCP_SHARE || '/data/webdav';
  await rm(`${share}/${DIR}`, { recursive: true, force: true });
  console.log(`  removed ${share}/${DIR}/`);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s)`}`);
process.exit(failures === 0 ? 0 : 1);