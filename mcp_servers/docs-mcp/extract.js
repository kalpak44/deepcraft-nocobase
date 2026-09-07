// Plain text out of whatever people drop on the WebDAV share.
//
// Two strategies, picked per format:
//
//   * The Open XML formats (docx, xlsx, pptx) are zip archives of XML, so they
//     are unzipped in process with fflate and the markup is stripped. No
//     subprocess, no native module, and no dependency that parses an untrusted
//     upload with a large attack surface.
//   * Everything else goes to a purpose-built command line tool. Reimplementing
//     PDF, or the legacy OLE containers .doc/.xls/.ppt, in JavaScript is not
//     something this server should be doing, and poppler and catdoc have been
//     doing it correctly for twenty years.
//
// Every extractor returns a string. A format we cannot read throws, and the
// caller records the reason against the file rather than failing the scan — one
// corrupt upload must not stop the rest of the share being indexed.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { unzipSync, strFromU8 } from 'fflate';

const run = promisify(execFile);

// A scanned PDF or a spreadsheet of formulas can be large and yield nothing, so
// the guards are on the input as well as the output.
export const MAX_BYTES = 64 * 1024 * 1024;
const MAX_CHARS = 4 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 120_000;

// Buffer, not stdout inheritance: a 60M PDF's text still has to fit somewhere,
// and the default 1M maxBuffer silently truncates.
async function tool(cmd, args) {
  try {
    const { stdout } = await run(cmd, args, {
      timeout: TOOL_TIMEOUT_MS,
      maxBuffer: MAX_CHARS,
      encoding: 'utf8'
    });
    return stdout;
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`${cmd} is not installed on this host`);
    }
    if (err.killed) {
      throw new Error(`${cmd} timed out after ${TOOL_TIMEOUT_MS / 1000}s`);
    }
    // Several of these tools write usable text to stdout and still exit
    // non-zero on a recoverable complaint, so partial output beats an error.
    if (err.stdout && err.stdout.trim()) return err.stdout;
    throw new Error(`${cmd} failed: ${(err.stderr || err.message).trim().slice(0, 200)}`);
  }
}

const XML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[ent] ?? m;
  });
}

// Turns an Open XML part into text. `breaks` names the closing tags that end a
// line — without them every paragraph in the document runs together into one
// unreadable line, which also ruins the search snippets.
function stripXml(xml, breaks = []) {
  let out = xml;
  for (const tag of breaks) {
    out = out.replaceAll(`</${tag}>`, `</${tag}>\n`);
  }
  out = out
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<(w|a):br\b[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return collapse(decodeEntities(out));
}

function collapse(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function unzip(buf, wanted) {
  // filter keeps the decompression to the parts we actually read: an xlsx can
  // carry megabytes of styles, themes and images we have no use for.
  return unzipSync(new Uint8Array(buf), {
    filter: (f) => wanted(f.name)
  });
}

function part(files, name) {
  const f = files[name];
  return f ? strFromU8(f) : null;
}

// ── Open XML ────────────────────────────────────────────────────────────────

function extractDocx(buf) {
  const files = unzip(buf, (n) =>
    n === 'word/document.xml' ||
    n === 'word/footnotes.xml' ||
    n === 'word/endnotes.xml'
  );
  const body = part(files, 'word/document.xml');
  if (body === null) throw new Error('not a docx: word/document.xml is missing');
  const notes = ['word/footnotes.xml', 'word/endnotes.xml']
    .map((n) => part(files, n))
    .filter(Boolean)
    .map((xml) => stripXml(xml, ['w:p']))
    .filter((t) => t.length > 0);
  const text = stripXml(body, ['w:p']);
  return notes.length ? `${text}\n\n--- Notes ---\n${notes.join('\n')}` : text;
}

function extractPptx(buf) {
  const files = unzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const names = Object.keys(files).sort((a, b) => slideNo(a) - slideNo(b));
  if (!names.length) throw new Error('not a pptx: no slides found');
  return collapse(
    names
      .map((n) => `--- Slide ${slideNo(n)} ---\n${stripXml(strFromU8(files[n]), ['a:p'])}`)
      .join('\n\n')
  );
}

const slideNo = (n) => Number(n.match(/(\d+)\.xml$/)?.[1] ?? 0);

// xlsx is the one worth doing carefully: a spreadsheet read as a flat blob of
// strings loses which value sat in which column, and that is most of what a
// spreadsheet means. Emitted as TSV per sheet so rows and columns survive into
// the model's context.
function extractXlsx(buf) {
  const files = unzip(buf, (n) =>
    n === 'xl/sharedStrings.xml' ||
    n === 'xl/workbook.xml' ||
    n === 'xl/_rels/workbook.xml.rels' ||
    /^xl\/worksheets\/sheet\d+\.xml$/.test(n)
  );

  // Cells of type "s" hold an index into this table rather than a value.
  const shared = [];
  const sharedXml = part(files, 'xl/sharedStrings.xml');
  if (sharedXml) {
    for (const m of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      // A single <si> can be split across several <t> runs by formatting.
      const runs = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]);
      shared.push(decodeEntities(runs.join('')));
    }
  }

  const sheets = sheetOrder(files);
  if (!sheets.length) throw new Error('not an xlsx: no worksheets found');

  const out = [];
  for (const { name, file } of sheets) {
    const xml = part(files, file);
    if (xml === null) continue;
    const rows = [];
    for (const rowM of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cellM of rowM[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        cells[colIndex(cellM[1])] = cellValue(cellM[1], cellM[2], shared);
      }
      // A row of only empty cells is noise; a row with any content keeps its
      // column positions, empty cells included, so the TSV stays aligned.
      if (cells.some((c) => c !== undefined && c !== '')) {
        rows.push(Array.from(cells, (c) => c ?? '').join('\t'));
      }
    }
    if (rows.length) out.push(`--- Sheet: ${name} ---\n${rows.join('\n')}`);
  }
  if (!out.length) throw new Error('the spreadsheet has no non-empty cells');
  return collapse(out.join('\n\n'));
}

// Sheet names live in workbook.xml, but the file each one maps to is only
// reachable through the relationship ids. Without this every sheet would be
// labelled by an arbitrary filename instead of the name the author gave it.
function sheetOrder(files) {
  const wb = part(files, 'xl/workbook.xml');
  const rels = part(files, 'xl/_rels/workbook.xml.rels');
  const present = Object.keys(files).filter((n) =>
    /^xl\/worksheets\/sheet\d+\.xml$/.test(n)
  );

  if (wb && rels) {
    const target = new Map();
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = m[0].match(/\bId="([^"]+)"/)?.[1];
      let t = m[0].match(/\bTarget="([^"]+)"/)?.[1];
      if (!id || !t) continue;
      t = t.replace(/^\/?(xl\/)?/, 'xl/');
      target.set(id, t);
    }
    const ordered = [];
    for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
      const name = m[0].match(/\bname="([^"]*)"/)?.[1];
      const rid = m[0].match(/r:id="([^"]+)"/)?.[1];
      const file = rid && target.get(rid);
      if (name && file && files[file]) ordered.push({ name, file });
    }
    if (ordered.length) return ordered;
  }

  // Malformed or unusual workbook: index what is there rather than nothing.
  return present
    .sort((a, b) => slideNo(a) - slideNo(b))
    .map((file) => ({ name: file.replace(/^xl\/worksheets\//, ''), file }));
}

function colIndex(attrs) {
  const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
  if (!ref) return 0;
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function cellValue(attrs, body, shared) {
  const type = attrs.match(/\bt="([^"]+)"/)?.[1];
  if (type === 'inlineStr') {
    const runs = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]);
    return decodeEntities(runs.join(''));
  }
  const v = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
  if (v === undefined) return '';
  if (type === 's') return shared[Number(v)] ?? '';
  // Everything else — numbers, dates as serials, booleans — is reported as
  // written. Resolving number formats would mean parsing styles.xml, and the
  // raw value is still searchable and still readable to the model.
  return decodeEntities(v);
}

// ── Everything else ─────────────────────────────────────────────────────────

// -layout keeps columns and tables roughly where they were on the page, which
// matters for contracts and invoices far more than it costs.
const extractPdf = (path) => tool('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-']);

// A .doc is often not a .doc: Word has shipped several containers under that
// extension, and people rename files. antiword is the better reader when it is
// genuinely OLE Word; catdoc is more forgiving, so it gets the second try.
async function extractDoc(path) {
  try {
    return await tool('antiword', ['-m', 'UTF-8.txt', path]);
  } catch {
    return tool('catdoc', ['-d', 'utf-8', path]);
  }
}

const extractXls = (path) => tool('xls2csv', ['-d', 'utf-8', path]);
const extractPpt = (path) => tool('catppt', ['-d', 'utf-8', path]);

async function extractText(path) {
  return collapse(await readFile(path, 'utf8'));
}

async function extractHtml(path) {
  const raw = await readFile(path, 'utf8');
  return collapse(
    decodeEntities(
      raw
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
        .replace(/<\/(p|div|br|li|tr|h[1-6])\s*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
    )
  );
}

// The extension is what the share gives us, and it is what the WebDAV clients
// set. Sniffing magic bytes would be better, but a wrong guess here costs one
// unreadable file rather than a wrong answer, and the zip readers verify the
// container anyway.
const BY_EXT = {
  pdf: { kind: 'path', fn: extractPdf },
  docx: { kind: 'buffer', fn: extractDocx },
  xlsx: { kind: 'buffer', fn: extractXlsx },
  xlsm: { kind: 'buffer', fn: extractXlsx },
  pptx: { kind: 'buffer', fn: extractPptx },
  doc: { kind: 'path', fn: extractDoc },
  xls: { kind: 'path', fn: extractXls },
  ppt: { kind: 'path', fn: extractPpt },
  rtf: { kind: 'path', fn: (p) => tool('catdoc', ['-d', 'utf-8', p]) },
  txt: { kind: 'path', fn: extractText },
  md: { kind: 'path', fn: extractText },
  csv: { kind: 'path', fn: extractText },
  tsv: { kind: 'path', fn: extractText },
  json: { kind: 'path', fn: extractText },
  log: { kind: 'path', fn: extractText },
  xml: { kind: 'path', fn: extractHtml },
  html: { kind: 'path', fn: extractHtml },
  htm: { kind: 'path', fn: extractHtml }
};

export const SUPPORTED = Object.keys(BY_EXT).sort();

export function isSupported(ext) {
  return Object.hasOwn(BY_EXT, ext);
}

// path is absolute and has already been confined to the share root by the
// caller — nothing here re-checks it, so do not call this with a raw tool
// argument.
export async function extract(path, ext, size) {
  const handler = BY_EXT[ext];
  if (!handler) throw new Error(`unsupported format: .${ext}`);
  if (size > MAX_BYTES) {
    throw new Error(`file is ${Math.round(size / 1e6)}MB, over the ${MAX_BYTES / 1e6}MB limit`);
  }

  const text = handler.kind === 'buffer'
    ? handler.fn(await readFile(path))
    : await handler.fn(path);

  const out = (await text) ?? '';
  if (!out.trim()) {
    // Overwhelmingly a scanned PDF. Saying so is worth more to the person
    // reading the tool output than an empty string, because the fix is OCR.
    throw new Error(
      ext === 'pdf'
        ? 'no text layer — this looks like a scan, which needs OCR to be readable'
        : 'no extractable text'
    );
  }
  return out.length > MAX_CHARS ? `${out.slice(0, MAX_CHARS)}\n\n[truncated]` : out;
}