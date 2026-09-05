// Load every admin page in a real browser and fail if one of them kills the tab.
//
//   just smoke
//
// Why a browser and not curl: a NocoBase page is a schema the client renders, so
// a bad step param crashes the *renderer* while every API call it made returns
// 200 in single-digit milliseconds. `app:getInfo` answering proves the server is
// up; it says nothing about whether the UI comes up. That gap is what this
// closes — a Kanban card carrying `filterByTk` once took the board page down on
// three loads out of four while the box looked perfectly healthy.
//
// Config comes from the environment (the recipe exports it from .env):
//   NOCOBASE_PUBLIC_URL   site to check, e.g. https://ownai.deepcraftstudio.com
//   NOCOBASE_ROOT_EMAIL / NOCOBASE_ROOT_PASSWORD   an account that can see the pages
//   SMOKE_LOADS           loads per page, default 3
//   SMOKE_SETTLE_MS       how long to let a page run before judging it, default 8000
//   SMOKE_EVAL_MS         how long to wait for the main thread to answer, default 10000
import { chromium } from 'playwright';

const BASE = (process.env.NOCOBASE_PUBLIC_URL || '').replace(/\/+$/, '');
const EMAIL = process.env.NOCOBASE_ROOT_EMAIL || '';
const PASSWORD = process.env.NOCOBASE_ROOT_PASSWORD || '';
const LOADS = Number(process.env.SMOKE_LOADS || 3);
const SETTLE_MS = Number(process.env.SMOKE_SETTLE_MS || 8000);

// A pinned renderer never answers page.evaluate, and Playwright puts no timeout
// on it — so without a bound the check hangs forever on precisely the failure it
// exists to find. A page that cannot answer in this long is not slow, it is hung.
const EVAL_MS = Number(process.env.SMOKE_EVAL_MS || 10000);

// A sentinel rather than a thrown error: the page not answering is an expected
// outcome of this check, not an exception in it.
const PINNED = Symbol('pinned');

// A page that survives but pins the main thread is also broken, just less
// obviously. Chosen well above a healthy load (measured ~130-185MB on this
// installation) so it flags a runaway rather than ordinary weight.
const HEAP_LIMIT_MB = Number(process.env.SMOKE_HEAP_LIMIT_MB || 900);

for (const [name, value] of Object.entries({ NOCOBASE_PUBLIC_URL: BASE, NOCOBASE_ROOT_EMAIL: EMAIL, NOCOBASE_ROOT_PASSWORD: PASSWORD })) {
  if (!value) {
    console.error(`${name} is not set — see .env.example`);
    process.exit(2);
  }
}

const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}/api/${path}`, init);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
};

// Sign in over the API rather than driving the login form: the form is a page
// like any other, and a broken one would make every check fail for the wrong
// reason.
const signIn = async () => {
  const body = await api('auth:signIn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Authenticator': 'basic' },
    body: JSON.stringify({ account: EMAIL, password: PASSWORD }),
  });
  return body.data.token;
};

// Discovered, not hardcoded: a page added after this was written is checked
// too, and a page that is deleted stops being checked without an edit here.
const listPages = async (token) => {
  const body = await api('desktopRoutes:listAccessible?tree=true&sort=sort', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const pages = [];
  const walk = (rows) => {
    for (const row of rows || []) {
      if (row.type === 'page' || row.type === 'flowPage') {
        if (row.schemaUid) pages.push({ title: row.title || '(untitled)', uid: row.schemaUid });
      }
      walk(row.children);
    }
  };
  walk(body.data);
  return pages;
};

// Closing a context whose renderer has died never returns, so a plain
// `await context.close()` hangs on precisely the failure this check exists to
// find. Bounded, and a leaked context is harmless — the browser is closed at
// the end of the run either way.
const closeQuietly = (context) =>
  Promise.race([
    context.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);

const checkOnce = async (browser, token, page) => {
  const context = await browser.newContext();
  let crashed = false;
  const errors = [];
  try {
    await context.addInitScript((t) => localStorage.setItem('NOCOBASE_TOKEN', t), token);
    const tab = await context.newPage();
    tab.on('crash', () => { crashed = true; });
    tab.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));

    // 'commit' rather than 'load': a page that hangs the renderer never fires
    // load, and waiting for it would time out instead of reporting the crash.
    await tab.goto(`${BASE}/admin/${page.uid}`, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
    await tab.waitForTimeout(SETTLE_MS).catch(() => {});

    if (crashed) return { ok: false, reason: 'renderer crashed' };

    // Reaching this at all means the main thread answered, which a spinning
    // page cannot do — so running out of patience here IS the result, not a
    // flake. The evaluate keeps its own catch: once the race is settled a late
    // rejection has nothing awaiting it, and would take the process down.
    let timer;
    const stats = await Promise.race([
      tab.evaluate(() => ({
        heapMB: Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576),
        dom: document.getElementsByTagName('*').length,
      })).catch((e) => ({ failed: String(e.message).split('\n')[0].slice(0, 200) })),
      new Promise((resolve) => { timer = setTimeout(() => resolve(PINNED), EVAL_MS); }),
    ]);
    clearTimeout(timer);

    if (stats === PINNED) return { ok: false, reason: `main thread pinned, no answer in ${EVAL_MS}ms` };
    if (stats.failed) return { ok: false, reason: crashed ? 'renderer crashed' : stats.failed };
    if (stats.heapMB > HEAP_LIMIT_MB) {
      return { ok: false, reason: `heap ${stats.heapMB}MB over the ${HEAP_LIMIT_MB}MB limit`, stats };
    }
    return { ok: true, stats, errors };
  } catch (e) {
    // page.evaluate throwing "Target crashed" is the crash arriving late.
    const message = String(e.message || e).split('\n')[0];
    return { ok: false, reason: crashed ? 'renderer crashed' : message.slice(0, 200) };
  } finally {
    await closeQuietly(context);
  }
};

const token = await signIn();
const pages = await listPages(token);
if (pages.length === 0) {
  console.error('no accessible pages returned — is the account allowed to see any?');
  process.exit(2);
}

console.log(`${BASE} — ${pages.length} page(s), ${LOADS} load(s) each\n`);
const browser = await chromium.launch();
const failures = [];

for (const page of pages) {
  const marks = [];
  for (let i = 0; i < LOADS; i++) {
    const result = await checkOnce(browser, token, page);
    if (result.ok) {
      marks.push(`${result.stats.heapMB}MB/${result.stats.dom}n`);
    } else {
      marks.push(`FAIL(${result.reason})`);
      failures.push({ ...page, reason: result.reason });
    }
  }
  const bad = marks.some((m) => m.startsWith('FAIL'));
  console.log(`  ${bad ? 'FAIL' : ' ok '}  ${page.title.padEnd(24)} /admin/${page.uid.padEnd(13)} ${marks.join('  ')}`);
}

await browser.close();

if (failures.length) {
  console.error(`\n${failures.length} failed load(s):`);
  for (const f of failures) console.error(`  ${f.title} (/admin/${f.uid}) — ${f.reason}`);
  console.error('\nA crash here is the page schema, not the server. Read the block');
  console.error('configuration with: /api/flowModels:findOne?parentId=<tabs uid>&subKey=grid');
  process.exit(1);
}

console.log('\nall pages rendered');
