const BASE_URL = process.env.CIELA_BASE_URL || 'https://web7.ciela.net';
const USERNAME = process.env.CIELA_USERNAME;
const PASSWORD = process.env.CIELA_PASSWORD;

if (!USERNAME || !PASSWORD) {
  throw new Error('CIELA_USERNAME and CIELA_PASSWORD env vars are required');
}

let cachedToken = null;
let cachedExp = 0; // unix seconds
let loginPromise = null; // in-flight login dedupe

function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return payload.exp || 0;
  } catch (e) {
    return 0;
  }
}

async function doLogin() {
  const resp = await fetch(`${BASE_URL}/proxy/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Ciela login failed: ${resp.status} ${resp.statusText} ${text.slice(0, 300)}`);
  }
  const json = await resp.json();
  if (!json.token) {
    throw new Error(`Ciela login response had no token: ${JSON.stringify(json).slice(0, 300)}`);
  }
  cachedToken = json.token;
  cachedExp = decodeJwtExp(json.token);
  return cachedToken;
}

async function login() {
  if (!loginPromise) {
    loginPromise = doLogin().finally(() => {
      loginPromise = null;
    });
  }
  return loginPromise;
}

async function getToken() {
  const nowSec = Date.now() / 1000;
  // refresh if missing or expiring within the next 60s
  if (!cachedToken || cachedExp - nowSec < 60) {
    await login();
  }
  return cachedToken;
}

async function authedFetch(url, options = {}) {
  const token = await getToken();
  const resp = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`
    }
  });
  if (resp.status === 401) {
    // token might have been invalidated server-side (e.g. concurrent session kicked us) -- retry once with a fresh login
    await login();
    return fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${cachedToken}`
      }
    });
  }
  return resp;
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildCitationUrl(dbId, docId, searchGuid) {
  return `${BASE_URL}/${dbId}/chighlight/${docId}/gethighlightnavigation/${searchGuid}/2147483647/0`;
}

/**
 * Search Ciela's full-text index. Ranks exact/near-exact phrase matches highest,
 * so prefer the complete document title/citation over vague short phrases.
 */
export async function search(searchPhrase, limit = 10) {
  const r1 = await authedFetch(
    `${BASE_URL}/proxy/api/CSearch?limit=${limit}&offset=0&orderBy=score%20desc`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchPhrase, onlyInDbs: null })
    }
  );
  if (!r1.ok) {
    throw new Error(`Ciela search failed: ${r1.status} ${r1.statusText}`);
  }
  const j1 = await r1.json();
  const resultsHref = j1?.searchContent?.first?.href;
  const searchGuid =
    j1?.searchContent?.searchGuid || resultsHref?.match(/searchcontent\/([a-f0-9-]+)/)?.[1];
  if (!resultsHref) {
    return { totalCount: j1?.searchContent?.size || 0, results: [] };
  }

  const r2 = await authedFetch(resultsHref, { method: 'GET' });
  if (!r2.ok) {
    throw new Error(`Ciela search results fetch failed: ${r2.status} ${r2.statusText}`);
  }
  const j2 = await r2.json();
  const results = (j2.value || []).map((v) => ({
    id: v.id,
    dbId: v.dbId,
    title: v.title,
    date: v.dateCommon,
    score: v.score,
    contentHref: v.href,
    citationUrl: buildCitationUrl(v.dbId, v.id, searchGuid || '')
  }));
  return { totalCount: j2.size, results };
}

/**
 * Fetch a document's full text by its contentHref (from search results).
 */
export async function getDocument(contentHref) {
  const resp = await authedFetch(contentHref, { method: 'GET' });
  if (!resp.ok) {
    throw new Error(`Ciela document fetch failed: ${resp.status} ${resp.statusText}`);
  }
  const json = await resp.json();

  const title = json?.navigation?.item?.titleInStructure || json?.navigation?.searchPhrase || null;

  // contentHref looks like: https://web7.ciela.net/proxy/api/{dbId}/chighlight/{docId}/chighlightdocument/{searchGuid}
  const m = contentHref.match(/\/api\/(\d+)\/chighlight\/(\d+)\/chighlightdocument\/([a-f0-9-]+)/i);
  const citationUrl = m ? buildCitationUrl(m[1], m[2], m[3]) : null;

  const renderFragments = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.render === 'string') {
      renderFragments.push(node.render);
    }
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (Array.isArray(val)) {
        val.forEach(walk);
      } else if (val && typeof val === 'object') {
        walk(val);
      }
    }
  }
  walk(json);

  const text = renderFragments.map(stripHtml).filter(Boolean).join('\n\n');
  return { title, citationUrl, text, rawFragmentCount: renderFragments.length };
}

export async function getTokenForDebug() {
  return getToken();
}
