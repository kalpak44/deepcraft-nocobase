// Sentence embeddings, computed on this box and nowhere else.
//
// The NocoBase installation's only LLM service is DeepSeek, which has no
// embedding endpoint, so the semantic half of the search cannot borrow it.
// Sending the share's contents to a third party to be embedded is not a
// reasonable default for a document share that holds client material, so the
// model runs locally: multilingual-e5-small, int8 quantized, through
// onnxruntime. Small enough for a 4G box, multilingual enough for the Bulgarian
// and Russian documents this deployment actually holds.
//
// It is loaded lazily and unloaded again when idle. Measured on this box, the
// loaded model costs ~470M of RSS on top of node's ~85M, and a scan that is
// actively embedding peaks near 1G. Keeping that resident between questions
// would be the single largest process on a 4G box shared with NocoBase, so it
// is disposed after DOCS_MCP_EMBED_IDLE_MS and reloaded on demand — a ~3s cost
// on the first semantic query after an idle period, against ~470M of headroom
// back for the rest of the time. A keyword-only query, a listing or a plain
// read never loads it at all.

// package.json pins sharp with an `overrides` entry, and this is the only file
// that explains why — JSON has nowhere to put a comment.
//
// @huggingface/transformers depends on sharp for its *image* pipelines and
// requires ^0.34.x. Every sharp below 0.35.0 inherits four libvips CVEs
// (GHSA-f88m-g3jw-g9cj), and no release of transformers — 4.2.0 included —
// allows a fixed one, so Dependabot cannot resolve it and its workflow fails
// on the repository rather than opening a PR.
//
// The override is safe here because of the single line below: this server asks
// for 'feature-extraction' and nothing else. No image pipeline is ever
// constructed, so sharp is never loaded, and forcing it outside the range
// transformers declares costs nothing. If this file ever grows an image
// pipeline, that reasoning stops holding and the override has to be revisited.
import { env, pipeline } from '@huggingface/transformers';

// Shipped and checksum-pinned by the docs_mcp role, never fetched at runtime:
// a deploy that silently downloaded a model would be neither reproducible nor
// offline-safe. allowRemoteModels=false makes a missing file fail loudly here
// instead of turning into a hub request.
env.allowRemoteModels = false;
env.localModelPath = process.env.DOCS_MCP_MODEL_DIR || '/data/docs-mcp/models';

const MODEL = process.env.DOCS_MCP_MODEL || 'multilingual-e5-small';

// The box has two cores and shares them with NocoBase. Left to itself
// onnxruntime takes all of them, which turns an ingest into a visible stall in
// the application — same reasoning as whisper_threads in the whisper role.
const THREADS = Number(process.env.DOCS_MCP_EMBED_THREADS || 1);

// Modest, because peak memory during a batch scales with it and this competes
// with NocoBase for a 4G box.
const BATCH = Number(process.env.DOCS_MCP_EMBED_BATCH || 8);

// How long the loaded model may sit unused before it is dropped. 0 keeps it
// resident for the life of the process.
const IDLE_MS = Number(process.env.DOCS_MCP_EMBED_IDLE_MS ?? 300_000);

let extractorPromise = null;
let idleTimer = null;
let inFlight = 0;

function load() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODEL, {
      dtype: 'q8',
      session_options: {
        intraOpNumThreads: THREADS,
        interOpNumThreads: THREADS
      }
    }).catch((err) => {
      // Reset, so a transient failure does not poison every later call with the
      // same rejected promise.
      extractorPromise = null;
      throw new Error(
        `embedding model '${MODEL}' failed to load from ${env.localModelPath}: ${err.message}`
      );
    });
  }
  return extractorPromise;
}

// Never unload with work in flight, and never leave a timer holding the process
// open — unref keeps this from delaying a clean shutdown.
function scheduleUnload() {
  if (!IDLE_MS) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (inFlight > 0 || !extractorPromise) return;
    const pending = extractorPromise;
    extractorPromise = null;
    try {
      const extractor = await pending;
      await extractor.dispose();
    } catch {
      // A model that failed to load has nothing to dispose.
    }
  }, IDLE_MS);
  idleTimer.unref?.();
}

// e5 was trained with these prefixes and is measurably worse without them: a
// query embedded as a passage lands in a different part of the space. This is
// the single easiest thing to get wrong about this family of models.
const asQuery = (t) => `query: ${t}`;
const asPassage = (t) => `passage: ${t}`;

async function encode(texts) {
  inFlight++;
  try {
    const extractor = await load();
    const out = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      // Mean pooling and L2 normalisation are what make a dot product a cosine
      // similarity, which is what the ranking below assumes.
      const tensor = await extractor(batch, { pooling: 'mean', normalize: true });
      out.push(...tensor.tolist().map((v) => Float32Array.from(v)));
    }
    return out;
  } finally {
    inFlight--;
    scheduleUnload();
  }
}

export const embedPassages = (texts) => encode(texts.map(asPassage));
export const embedQuery = async (text) => (await encode([asQuery(text)]))[0];

// Already normalised, so this is a plain dot product. Kept explicit rather than
// folded into the caller because it is the one line the ranking depends on.
export function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

// SQLite has no vector type and this corpus does not need one. A document share
// is thousands of chunks, not millions: at 384 dimensions that is a few MB of
// Float32 read once per query and scanned in single-digit milliseconds. An
// approximate index (sqlite-vec, hnsw) would add a native loadable extension
// and a build step to save time that is not currently being spent. Revisit past
// roughly 100k chunks; until then this is the cheaper engineering.
export const toBlob = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);

export function fromBlob(buf) {
  // Copy rather than alias: the Buffer that comes back out of node:sqlite is not
  // guaranteed to be aligned for a Float32Array view.
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

// Measured on this box: a query against a clearly relevant passage scores
// around 0.88, against an unrelated one around 0.78. That compressed range is
// normal for the e5 family and it means an absolute cut has to be generous —
// this floor removes only obvious noise, and the ranking does the real work.
// store.js reports the raw score with every hit rather than relying on the cut,
// so the model can see how good a match actually is.
export const SIMILARITY_FLOOR = Number(process.env.DOCS_MCP_SIMILARITY_FLOOR || 0.72);

export const modelInfo = () => ({
  model: MODEL,
  dir: env.localModelPath,
  threads: THREADS,
  loaded: extractorPromise !== null,
  idleUnloadMs: IDLE_MS || null
});

// So /health and the ansible verification can tell "the model is present and
// loadable" from "the server is merely listening", without embedding anything.
export async function warm() {
  await load();
  return true;
}