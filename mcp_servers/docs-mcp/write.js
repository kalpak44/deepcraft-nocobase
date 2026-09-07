// Creating and editing documents on the share.
//
// What is and is not possible here, because the difference matters and no
// amount of prompting makes it go away:
//
//   * The text family (txt, md, csv, tsv, json, html, xml, log) is written
//     literally. Nothing to lose.
//   * docx and xlsx are *generated* as real Open XML when creating a new file.
//     The output is a plain document — correct, readable by Word and Excel, and
//     carrying no styling beyond the default, because there is no source
//     formatting to carry.
//   * Editing an existing docx, xlsx or pptx is done by replacing text inside
//     the XML text nodes and rewriting the archive with every other part
//     untouched. That is what preserves the fonts, tables, images and styles
//     the author put there. The limitation is real and reported: Word splits a
//     paragraph into runs at every formatting change, so a search string that
//     straddles a bold word exists in no single text node and will not match.
//   * pdf, doc, xls and ppt cannot be written at all. Authoring a PDF or the
//     legacy OLE containers needs a converter — LibreOffice — that is not
//     installed on this box, and faking it by writing a renamed docx would
//     produce a file that only looks like the extension it claims. These are
//     refused with the reason.
//
// Nothing here deletes a file, and nothing overwrites one unless the caller
// explicitly asked to.

import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

// Written literally, exactly as given.
const TEXT_FORMATS = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'html', 'htm', 'xml', 'log']);
// Generated from scratch on create, text-replaced in place on edit.
const OOXML_FORMATS = new Set(['docx', 'xlsx']);
// Editable in place, but not creatable: generating a deck is a different job.
const OOXML_EDIT_ONLY = new Set(['pptx']);
// Not writable by any means available on this box.
const READ_ONLY_FORMATS = {
  pdf: 'a PDF cannot be authored here — no converter is installed. Write a .docx instead.',
  doc: 'the legacy binary .doc format cannot be written. Use .docx.',
  xls: 'the legacy binary .xls format cannot be written. Use .xlsx.',
  ppt: 'the legacy binary .ppt format cannot be written. Use .pptx.',
  rtf: 'RTF cannot be written here. Use .docx or .md.'
};

export const WRITABLE = [...TEXT_FORMATS, ...OOXML_FORMATS].sort();
export const EDITABLE = [...TEXT_FORMATS, ...OOXML_FORMATS, ...OOXML_EDIT_ONLY].sort();

function refuse(ext, verb) {
  if (Object.hasOwn(READ_ONLY_FORMATS, ext)) {
    throw new Error(`cannot ${verb} .${ext}: ${READ_ONLY_FORMATS[ext]}`);
  }
  throw new Error(
    `cannot ${verb} .${ext || '(no extension)'} — ${verb === 'create' ? 'creatable' : 'editable'} ` +
    `formats are ${(verb === 'create' ? WRITABLE : EDITABLE).map((e) => `.${e}`).join(' ')}`
  );
}

// Two escapers, and the difference between them is load-bearing.
//
// escText is for XML *content*, and escapes only the three characters that have
// to be: & < >. It is used both to write text nodes and to build the search
// needle for an edit -- and that is exactly why it must not touch the quote.
// Word writes a double quote literally inside <w:t>, so a needle carrying
// &quot; would match nothing. escAttr is for attribute values, where the quote
// does have to be escaped.
//
// Control characters are stripped because they are not legal in XML 1.0 and
// Word rejects the whole file rather than ignoring them.
const XML_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

const escText = (s) =>
  String(s)
    .replace(XML_CONTROL, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

const escAttr = (s) => escText(s).replaceAll('"', '&quot;');

// ── Generating a docx ───────────────────────────────────────────────────────

const CONTENT_TYPES_DOCX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = (target, type) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>
</Relationships>`;

function docxFromText(text) {
  // A blank line starts a new paragraph; a single newline is a line break
  // within one. That is what people mean when they type it, and it is what
  // reading the file back gives again.
  const paragraphs = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const body = paragraphs
    .map((para) => {
      const runs = para
        .split('\n')
        .map((line, i) => {
          const br = i === 0 ? '' : '<w:br/>';
          // xml:space="preserve" or Word discards leading and trailing spaces.
          return `${br}<w:r><w:t xml:space="preserve">${escText(line)}</w:t></w:r>`;
        })
        .join('');
      return `<w:p>${runs}</w:p>`;
    })
    .join('');

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;

  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES_DOCX),
    '_rels/.rels': strToU8(ROOT_RELS('word/document.xml', 'officeDocument')),
    'word/document.xml': strToU8(document)
  });
}

// ── Generating an xlsx ──────────────────────────────────────────────────────

const CONTENT_TYPES_XLSX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

function colName(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// A value that is a number is written as one, so Excel can sum the column
// rather than showing it left-aligned as text. Everything else is an inline
// string, which avoids a sharedStrings part entirely.
function cell(ref, value) {
  if (value === null || value === undefined || value === '') return '';
  const num = typeof value === 'number' ? value : null;
  if (num !== null && Number.isFinite(num)) {
    return `<c r="${ref}"><v>${num}</v></c>`;
  }
  const s = String(value);
  if (s !== '' && s.trim() !== '' && Number.isFinite(Number(s))) {
    return `<c r="${ref}"><v>${Number(s)}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escText(s)}</t></is></c>`;
}

function xlsxFromRows(rows, sheetName = 'Sheet1') {
  const sheetData = rows
    .map((row, r) => {
      const cells = row.map((v, c) => cell(`${colName(c)}${r + 1}`, v)).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escAttr(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES_XLSX),
    '_rels/.rels': strToU8(ROOT_RELS('xl/workbook.xml', 'officeDocument')),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(wbRels),
    'xl/worksheets/sheet1.xml': strToU8(sheet)
  });
}

// Accepts either explicit rows or the tab/comma separated text a model is
// likelier to produce, so "write me a spreadsheet of these figures" works
// without the caller having to build a matrix.
function toRows(content, rows) {
  if (Array.isArray(rows)) return rows.map((r) => (Array.isArray(r) ? r : [r]));
  const text = String(content ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [[]];
  const lines = text.split('\n');
  const sep = lines[0].includes('\t') ? '\t' : ',';
  return lines.map((line) => line.split(sep).map((c) => c.trim()));
}

// ── Editing in place ────────────────────────────────────────────────────────

// Only the text-bearing parts, and only the text inside their text elements.
// Replacing across the whole XML would corrupt tag names and attributes.
const EDIT_PARTS = {
  docx: (n) =>
    n === 'word/document.xml' ||
    /^word\/(header|footer)\d*\.xml$/.test(n) ||
    n === 'word/footnotes.xml' ||
    n === 'word/endnotes.xml',
  xlsx: (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  pptx: (n) => /^ppt\/(slides|notesSlides)\/[a-zA-Z]+\d+\.xml$/.test(n)
};

const TEXT_NODE = /(<(?:w:|a:)?t\b[^>]*>)([\s\S]*?)(<\/(?:w:|a:)?t>)/g;

function replaceInTextNodes(xml, find, replace) {
  let count = 0;
  const out = xml.replace(TEXT_NODE, (whole, open, body, close) => {
    if (!body.includes(find)) return whole;
    const parts = body.split(find);
    count += parts.length - 1;
    return open + parts.join(replace) + close;
  });
  return { xml: out, count };
}

function editOoxml(buf, ext, find, replace) {
  // No filter: every part has to come back out so the archive can be rewritten
  // whole. Dropping one would strip the styles or the images.
  const files = unzipSync(new Uint8Array(buf));
  const isTarget = EDIT_PARTS[ext];
  // The needle has to be escaped the same way the part's text is, or a search
  // for "Jones & Son" would never match "Jones &amp; Son".
  const find_ = escText(find);
  const replace_ = escText(replace);

  let total = 0;
  for (const name of Object.keys(files)) {
    if (!isTarget(name)) continue;
    const { xml, count } = replaceInTextNodes(strFromU8(files[name]), find_, replace_);
    if (count) {
      files[name] = strToU8(xml);
      total += count;
    }
  }
  return { buf: Buffer.from(zipSync(files)), count: total };
}

// ── The two operations ──────────────────────────────────────────────────────

// Written to a temp file in the same directory and renamed over the target, so
// a reader on the share never sees a half-written document and a failure part
// way through leaves the original intact. Same directory, because rename across
// filesystems fails with EXDEV.
async function writeAtomic(abs, data) {
  const dir = path.dirname(abs);
  await mkdir(dir, { recursive: true });
  // Leading dot, so that if a scan runs while a write is in progress the
  // indexer skips the temp file instead of recording it as an unreadable .tmp.
  const tmp = path.join(dir, `.${path.basename(abs)}.docs-mcp-${process.pid}.tmp`);
  await writeFile(tmp, data);
  await rename(tmp, abs);
}

const exists = async (abs) => {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
};

export async function createDocument({ abs, ext, content, rows, sheetName, overwrite }) {
  if (!TEXT_FORMATS.has(ext) && !OOXML_FORMATS.has(ext)) refuse(ext, 'create');

  const already = await exists(abs);
  if (already && !overwrite) {
    throw new Error(
      'that file already exists — pass overwrite:true to replace it, or use edit_document to ' +
      'change part of it while keeping the rest'
    );
  }

  let data;
  if (ext === 'docx') data = Buffer.from(docxFromText(content ?? ''));
  else if (ext === 'xlsx') data = Buffer.from(xlsxFromRows(toRows(content, rows), sheetName));
  else data = Buffer.from(String(content ?? ''), 'utf8');

  await writeAtomic(abs, data);
  return { bytes: data.length, replaced: already };
}

export async function editDocument({ abs, ext, find, replace, append, expectedCount }) {
  if (!(await exists(abs))) {
    throw new Error('no such file on the share — use write_document to create it');
  }
  if (!TEXT_FORMATS.has(ext) && !OOXML_FORMATS.has(ext) && !OOXML_EDIT_ONLY.has(ext)) {
    refuse(ext, 'edit');
  }

  if (append !== undefined && append !== null && append !== '') {
    if (!TEXT_FORMATS.has(ext)) {
      throw new Error(
        `append only works on the text formats (${[...TEXT_FORMATS].map((e) => `.${e}`).join(' ')}); ` +
        `for .${ext}, use find/replace, or write_document with overwrite:true to replace it whole`
      );
    }
    const existing = await readFile(abs, 'utf8');
    const joined = existing.endsWith('\n') ? existing + append : `${existing}\n${append}`;
    await writeAtomic(abs, Buffer.from(joined, 'utf8'));
    return { operation: 'append', addedChars: append.length, bytes: Buffer.byteLength(joined) };
  }

  if (!find) throw new Error('give either find (with replace) or append');

  let count;
  let data;
  if (TEXT_FORMATS.has(ext)) {
    const existing = await readFile(abs, 'utf8');
    const parts = existing.split(find);
    count = parts.length - 1;
    data = Buffer.from(parts.join(replace ?? ''), 'utf8');
  } else {
    const result = editOoxml(await readFile(abs), ext, find, replace ?? '');
    count = result.count;
    data = result.buf;
  }

  if (count === 0) {
    throw new Error(
      TEXT_FORMATS.has(ext)
        ? 'that text does not appear in the file — nothing was changed'
        : 'that text does not appear in any single text run — nothing was changed. Word and Excel ' +
          'split text at every formatting change, so a phrase spanning a bold or coloured word ' +
          'cannot be matched as one string. Try a shorter fragment that sits inside one run, and ' +
          'read the file with get_document_text first to see the exact wording.'
    );
  }
  // A caller that knows how many occurrences it meant to change can say so, and
  // a mismatch aborts rather than quietly editing more of the document than
  // intended.
  if (expectedCount !== undefined && expectedCount !== null && count !== expectedCount) {
    throw new Error(
      `found ${count} occurrence${count === 1 ? '' : 's'} but expectedCount was ${expectedCount} — ` +
      'nothing was changed. Re-read the file and either correct expectedCount or use a more ' +
      'specific find string.'
    );
  }

  await writeAtomic(abs, data);
  return { operation: 'replace', replacements: count, bytes: data.length };
}