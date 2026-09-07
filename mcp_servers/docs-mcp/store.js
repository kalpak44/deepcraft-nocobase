// The index over the WebDAV share: what is on it, what it says, and how to
// find the part that answers a question.
//
// SQLite through node:sqlite, which ships with Node 24 and has FTS5 compiled
// in, so the lexical half needs no dependency and no native build. The semantic
// half stores its vectors as BLOBs in the same rows and scans them in process —
// see the note in embed.js for why that beats a vector extension at this size.
//
// The share is the source of truth and this file is a cache. It is rebuilt from
// whatever is on disk, so deleting it costs one re-extraction and loses nothing.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { extract, isSupported, SUPPORTED } from './extract.js';
import {
  cosine, embedPassages, embedQuery, fromBlob, toBlob, SIMILARITY_FLOOR
} from './embed.js';

export const ROOT = path.resolve(process.env.DOCS_MCP_SHARE || '/data/webdav');
const DB_PATH = process.env.DOCS_MCP_DB || '/data/docs-mcp/index.db';

// How stale a listing or a search may be before the share is re-walked. The
// walk itself only stats files, so this is cheap when nothing changed; the cost
// is re-extracting the files that did.
const SCAN_TTL_MS = Number(process.env.DOCS_MCP_SCAN_TTL_MS || 60_000);

// Chunk size is a compromise between retrieval precision and how much context
// one hit spends. ~1200 characters is roughly a paragraph or two, and the
// overlap keeps a sentence that straddles a boundary findable from either side.
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;

mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS files (
    path       TEXT PRIMARY KEY,
    ext        TEXT NOT NULL,
    size       INTEGER NOT NULL,
    mtime      INTEGER NOT NULL,
    chars      INTEGER,
    error      TEXT,
    embedded   INTEGER NOT NULL DEFAULT 0,
    indexed_at INTEGER NOT NULL
  );

  -- The extracted text, kept whole so a read does not re-run pdftotext.
  CREATE TABLE IF NOT EXISTS docs (
    path TEXT PRIMARY KEY,
    text TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chunks (
    id   INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    ord  INTEGER NOT NULL,
    body TEXT NOT NULL,
    vec  BLOB
  );
  CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);

  -- External-content FTS5: the chunks table owns the text, this only indexes it.
  -- remove_diacritics 2 so a query typed without accents still matches, and no
  -- stemmer, because the stemmers are English-only and this share is not.
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    body,
    content = 'chunks',
    content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
  );

  -- Triggers rather than hand-written index maintenance: every path that
  -- changes chunks keeps the index correct, including the deletes below.
  CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, body) VALUES (new.id, new.body);
  END;
  CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, body) VALUES('delete', old.id, old.body);
  END;
  CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, body) VALUES('delete', old.id, old.body);
    INSERT INTO chunks_fts(rowid, body) VALUES (new.id, new.body);
  END;
`);

const q = {
  allFiles: db.prepare('SELECT path, ext, size, mtime, chars, error, embedded FROM files ORDER BY path'),
  getFile: db.prepare('SELECT path, ext, size, mtime, chars, error, embedded FROM files WHERE path = ?'),
  upsertFile: db.prepare(`
    INSERT INTO files (path, ext, size, mtime, chars, error, embedded, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      ext = excluded.ext, size = excluded.size, mtime = excluded.mtime,
      chars = excluded.chars, error = excluded.error,
      embedded = excluded.embedded, indexed_at = excluded.indexed_at
  `),
  deleteFile: db.prepare('DELETE FROM files WHERE path = ?'),
  putDoc: db.prepare('INSERT INTO docs (path, text) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET text = excluded.text'),
  deleteDoc: db.prepare('DELETE FROM docs WHERE path = ?'),
  getDoc: db.prepare('SELECT text FROM docs WHERE path = ?'),
  deleteChunks: db.prepare('DELETE FROM chunks WHERE path = ?'),
  insertChunk: db.prepare('INSERT INTO chunks (path, ord, body, vec) VALUES (?, ?, ?, ?)'),
  pendingChunks: db.prepare('SELECT id, body FROM chunks WHERE path = ? AND vec IS NULL ORDER BY ord'),
  setVec: db.prepare('UPDATE chunks SET vec = ? WHERE id = ?'),
  markEmbedded: db.prepare('UPDATE files SET embedded = ? WHERE path = ?'),
  vectors: db.prepare('SELECT id, path, ord, body, vec FROM chunks WHERE vec IS NOT NULL'),
  lexical: db.prepare(`
    SELECT c.path, c.ord, c.body,
           snippet(chunks_fts, 0, '[', ']', ' … ', 14) AS snip,
           bm25(chunks_fts) AS score
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `),
  counts: db.prepare(`
    SELECT (SELECT COUNT(*) FROM files)                      AS files,
           (SELECT COUNT(*) FROM files WHERE error IS NOT NULL) AS failed,
           (SELECT COUNT(*) FROM chunks)                     AS chunks,
           (SELECT COUNT(*) FROM chunks WHERE vec IS NOT NULL) AS vectors,
           -- Non-zero here means semantic search is incomplete: those files
           -- match by keyword only until the next scan backfills them.
           (SELECT COUNT(*) FROM files WHERE embedded = 0 AND error IS NULL)
             AS awaitingEmbedding
  `)
};

// ── Paths ───────────────────────────────────────────────────────────────────

// Every path that arrives from a tool call goes through here. The share root is
// the boundary: a relative path is resolved against it and then proved to be
// inside it, so "../../etc/passwd" or an absolute path cannot address anything
// off the share. This is the only place that turns a caller's string into a
// filesystem path.
export function resolveInShare(rel) {
  const abs = path.resolve(ROOT, rel.replace(/^\/+/, ''));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw new Error(`path escapes the share: ${rel}`);
  }
  return abs;
}

const toRel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

// Hidden files, version-control directories and the lock files Word and Excel
// leave next to an open document. None of it is content, and "~$contract.docx"
// is not a readable docx.
const ignored = (name) => name.startsWith('.') || name.startsWith('~$');

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES') return out;
    throw err;
  }
  for (const e of entries) {
    if (ignored(e.name)) continue;
    const abs = path.join(dir, e.name);
    // Symlinks are skipped rather than followed: following one would let a
    // link planted on the share read a file outside it.
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await walk(abs, out);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

// ── Ingest ──────────────────────────────────────────────────────────────────

function chunk(text) {
  const out = [];
  // Prefer to break at a blank line, then at a sentence end, then anywhere —
  // a chunk that starts mid-word makes a bad snippet and a worse embedding.
  for (let i = 0; i < text.length; ) {
    let end = Math.min(i + CHUNK_CHARS, text.length);
    if (end < text.length) {
      const window = text.slice(i, end);
      const brk = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf('. ')
      );
      if (brk > CHUNK_CHARS * 0.5) end = i + brk + 1;
    }
    const body = text.slice(i, end).trim();
    if (body) out.push(body);
    if (end >= text.length) break;
    i = Math.max(end - CHUNK_OVERLAP, i + 1);
  }
  return out;
}

function forget(rel) {
  q.deleteChunks.run(rel);
  q.deleteDoc.run(rel);
}

async function ingest(abs, st) {
  const rel = toRel(abs);
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mtime = Math.floor(st.mtimeMs);
  const now = Date.now();

  if (!isSupported(ext)) {
    forget(rel);
    q.upsertFile.run(rel, ext, st.size, mtime, null, `unsupported format: .${ext || '(none)'}`, 0, now);
    return { rel, status: 'skipped' };
  }

  let text;
  try {
    text = await extract(abs, ext, st.size);
  } catch (err) {
    // Recorded against the file, not thrown: get_documents then reports exactly
    // why this one document is not searchable, which is the question its owner
    // will ask, and the rest of the share still indexes.
    forget(rel);
    q.upsertFile.run(rel, ext, st.size, mtime, null, err.message, 0, now);
    return { rel, status: 'failed', error: err.message };
  }

  const bodies = chunk(text);
  db.exec('BEGIN');
  try {
    forget(rel);
    q.putDoc.run(rel, text);
    for (const [ord, body] of bodies.entries()) q.insertChunk.run(rel, ord, body, null);
    q.upsertFile.run(rel, ext, st.size, mtime, text.length, null, 0, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Best effort, and deliberately after the commit: if the model is missing or
  // fails to load, the document is still fully searchable by keyword. Semantic
  // search degrades, the tool does not break.
  await embedPending(rel).catch((err) => {
    console.error(`docs-mcp: embedding failed for ${rel}: ${err.message}`);
  });

  return { rel, status: 'indexed', chunks: bodies.length, chars: text.length };
}

// Fill in the vectors for whichever of a file's chunks do not have one yet, and
// record on the file that embedding finished.
//
// This is separate from ingest because it has to be resumable. Embedding a
// large PDF is the slowest thing this server does, it happens after the text is
// already committed, and the ordinary way for it to be interrupted is a deploy
// restarting the service mid-scan. Before this existed the file was then left
// with text but no vectors, and — because a scan decides "unchanged" from size
// and mtime — it would never be embedded again: permanently invisible to
// semantic search while looking perfectly indexed. `embedded` is what makes
// that state visible and this function is what repairs it.
async function embedPending(rel) {
  const pending = q.pendingChunks.all(rel);
  if (!pending.length) {
    q.markEmbedded.run(1, rel);
    return 0;
  }
  const vectors = await embedPassages(pending.map((r) => r.body));
  db.exec('BEGIN');
  try {
    pending.forEach((row, i) => {
      if (vectors[i]) q.setVec.run(toBlob(vectors[i]), row.id);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  // Only once the vectors are committed, so an interruption between the two
  // leaves the file marked unembedded and the next scan retries it.
  q.markEmbedded.run(1, rel);
  return pending.length;
}

let lastScan = 0;
let scanning = null;

async function scanOnce() {
  const found = await walk(ROOT);
  const known = new Map(q.allFiles.all().map((r) => [r.path, r]));
  const changes = { indexed: 0, embedded: 0, failed: 0, skipped: 0, removed: 0, unchanged: 0 };

  for (const abs of found) {
    const rel = toRel(abs);
    let st;
    try {
      st = await stat(abs);
    } catch {
      continue; // deleted between the walk and the stat
    }
    const prev = known.get(rel);
    known.delete(rel);
    // Size and mtime together are the change signal. A content hash would be
    // stronger, but it means reading every byte of every file on every scan,
    // which is the cost this check exists to avoid.
    if (prev && prev.size === st.size && prev.mtime === Math.floor(st.mtimeMs)) {
      // The content is current, but its vectors may not be — an embed that was
      // interrupted leaves the text indexed and `embedded` at 0. Finish it here
      // rather than re-extracting, which would be the expensive way to fix a
      // problem that only needs the model.
      if (!prev.embedded && !prev.error) {
        try {
          if (await embedPending(rel)) changes.embedded++;
          else changes.unchanged++;
        } catch (err) {
          console.error(`docs-mcp: embedding backfill failed for ${rel}: ${err.message}`);
          changes.unchanged++;
        }
      } else {
        changes.unchanged++;
      }
      continue;
    }
    const r = await ingest(abs, st);
    changes[r.status === 'indexed' ? 'indexed' : r.status === 'failed' ? 'failed' : 'skipped']++;
  }

  // Whatever is left in `known` is no longer on the share.
  for (const rel of known.keys()) {
    forget(rel);
    q.deleteFile.run(rel);
    changes.removed++;
  }

  lastScan = Date.now();
  return changes;
}

// Serialised: two concurrent tool calls must not both walk and ingest, or the
// second would re-extract what the first is already committing.
export function scan({ force = false } = {}) {
  if (!force && Date.now() - lastScan < SCAN_TTL_MS) {
    return Promise.resolve(null);
  }
  if (!scanning) {
    scanning = scanOnce().finally(() => {
      scanning = null;
    });
  }
  return scanning;
}

export const ensureFresh = () => scan().catch((err) => {
  console.error(`docs-mcp: scan failed: ${err.message}`);
  return null;
});

// Re-read one file right now. Called after a write, because the next search has
// to see what was just written — leaving it to the scan TTL would make an edit
// look for up to a minute as though it had not happened.
export async function reindexOne(rel) {
  const abs = resolveInShare(rel);
  const key = toRel(abs);
  let st;
  try {
    st = await stat(abs);
  } catch {
    forget(key);
    q.deleteFile.run(key);
    return { path: key, status: 'removed' };
  }
  const result = await ingest(abs, st);
  return { ...result, path: key };
}

// ── Read ────────────────────────────────────────────────────────────────────

export function listDocuments({ prefix = '', ext = null } = {}) {
  const want = prefix.replace(/^\/+/, '').toLowerCase();
  return q.allFiles.all().filter((r) =>
    (!want || r.path.toLowerCase().startsWith(want)) &&
    (!ext || r.ext === ext.toLowerCase().replace(/^\./, ''))
  );
}

export function documentText(rel, offset = 0, limit = 40_000) {
  // Normalised through the share boundary so the caller can pass the path a
  // search result gave it, with or without a leading slash.
  const abs = resolveInShare(rel);
  const key = toRel(abs);
  const row = q.getDoc.get(key);
  const meta = q.getFile.get(key);
  if (!row) {
    if (meta?.error) throw new Error(`${key} could not be read: ${meta.error}`);
    throw new Error(`${key} is not on the share, or has not been indexed yet`);
  }
  const total = row.text.length;
  const from = Math.max(0, Math.min(offset, total));
  const slice = row.text.slice(from, from + Math.max(0, limit));
  return {
    path: key,
    ext: meta?.ext,
    totalChars: total,
    offset: from,
    returnedChars: slice.length,
    hasMore: from + slice.length < total,
    text: slice
  };
}

// ── Search ──────────────────────────────────────────────────────────────────

// A raw query cannot go into MATCH: FTS5 would read ", *, NEAR, OR and - as
// syntax and throw on unbalanced quotes. Terms are extracted and re-quoted as
// string literals, which makes any input a valid query with no operators.
function ftsTerms(query) {
  return (query.match(/[\p{L}\p{N}_]+/gu) || [])
    .filter((t) => t.length > 1)
    .slice(0, 24)
    .map((t) => `"${t}"`);
}

function lexicalSearch(query, limit) {
  const terms = ftsTerms(query);
  if (!terms.length) return [];
  const run = (expr) => {
    try {
      return q.lexical.all(expr, limit);
    } catch (err) {
      console.error(`docs-mcp: FTS query failed (${expr}): ${err.message}`);
      return [];
    }
  };
  // All terms first, because a document containing every one of them is almost
  // always the better answer; widen to any term only if that finds nothing.
  const strict = run(terms.join(' AND '));
  return strict.length ? strict : run(terms.join(' OR '));
}

async function semanticSearch(query, limit, floor) {
  const rows = q.vectors.all();
  if (!rows.length) return [];
  const qv = await embedQuery(query);
  return rows
    .map((r) => ({
      path: r.path,
      ord: r.ord,
      body: r.body,
      snip: r.body.slice(0, 400),
      similarity: cosine(qv, fromBlob(r.vec))
    }))
    .filter((r) => r.similarity >= floor)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

// Reciprocal rank fusion. The two halves produce incomparable numbers — bm25 is
// negative and unbounded, cosine is 0..1 — so they are combined by rank rather
// than by score, which needs no normalisation and no tuning per corpus.
const RRF_K = 60;

function fuse(lists) {
  const scored = new Map();
  for (const { rows, weight, source } of lists) {
    rows.forEach((row, i) => {
      const key = `${row.path}#${row.ord}`;
      const prev = scored.get(key) || { ...row, rrf: 0, sources: [] };
      prev.rrf += weight / (RRF_K + i + 1);
      prev.sources.push(source);
      // Carried through the fusion because it is the only number a reader can
      // interpret: rrf is a rank artefact, cosine is a similarity.
      if (row.similarity !== undefined) prev.similarity = row.similarity;
      // Keep the lexical snippet when there is one: it brackets the matched
      // term, which the semantic side has no way to identify.
      if (source === 'keyword') prev.snip = row.snip;
      scored.set(key, prev);
    });
  }
  return [...scored.values()].sort((a, b) => b.rrf - a.rrf);
}

export async function search({
  query, limit = 8, mode = 'hybrid', prefix = '', minSimilarity = SIMILARITY_FLOOR
} = {}) {
  await ensureFresh();

  // Over-fetch per half so the fusion has something to work with, then trim.
  const depth = Math.max(limit * 4, 20);
  const lists = [];

  if (mode === 'hybrid' || mode === 'keyword') {
    lists.push({ rows: lexicalSearch(query, depth), weight: 1, source: 'keyword' });
  }
  if (mode === 'hybrid' || mode === 'semantic') {
    try {
      lists.push({
        rows: await semanticSearch(query, depth, minSimilarity),
        weight: 1,
        source: 'semantic'
      });
    } catch (err) {
      // Same principle as ingest: without the model this is a keyword search,
      // not a failed one. The caller is told, so a missing model is visible
      // rather than quietly halving the result quality.
      console.error(`docs-mcp: semantic search unavailable: ${err.message}`);
      if (mode === 'semantic') throw err;
      lists.push({ rows: [], weight: 1, source: 'semantic-unavailable' });
    }
  }

  const want = prefix.replace(/^\/+/, '').toLowerCase();
  const fused = fuse(lists).filter((r) => !want || r.path.toLowerCase().startsWith(want));

  // Grouped by document: three good passages from one contract is one answer,
  // not three, and the model needs the file to go and read next.
  const byDoc = new Map();
  for (const hit of fused) {
    const doc = byDoc.get(hit.path) || { path: hit.path, score: 0, matches: [] };
    doc.score = Math.max(doc.score, hit.rrf);
    if (doc.matches.length < 3) {
      doc.matches.push({
        chunk: hit.ord,
        matchedBy: [...new Set(hit.sources)].join('+'),
        ...(hit.similarity !== undefined
          ? { similarity: Number(hit.similarity.toFixed(4)) }
          : {}),
        excerpt: hit.snip
      });
    }
    byDoc.set(hit.path, doc);
  }

  const docs = [...byDoc.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  for (const d of docs) {
    const meta = q.getFile.get(d.path);
    d.ext = meta?.ext;
    d.totalChars = meta?.chars ?? null;
    d.score = Number(d.score.toFixed(5));
  }
  return {
    query,
    mode,
    semanticAvailable: !lists.some((l) => l.source === 'semantic-unavailable'),
    matched: docs.length,
    results: docs
  };
}

export const stats = () => ({
  share: ROOT,
  supported: SUPPORTED,
  lastScan: lastScan ? new Date(lastScan).toISOString() : null,
  ...q.counts.get()
});