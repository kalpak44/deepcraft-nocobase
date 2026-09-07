// The fixed page scripts, and what lex-mcp knows about the two ways lex.bg
// fails to be a legal database.
//
// Everything here is a constant. Nothing an AI employee says reaches these as
// code — see the note on evaluate() in upstream.js.

export const LEX_HOST = 'lex.bg';

// Entry points that work, established by reading the live site rather than
// guessing. The site's own free-text search is unreliable — it answers "Няма
// резултати от търсенето!" for "Конституция", which is on the site — so the
// structured trees are the real way in and the prompt says so.
export const ENTRY_POINTS = {
  laws: 'https://lex.bg/laws/tree/laws',
  codes: 'https://lex.bg/laws/tree/code',
  guide: 'https://lex.bg/guide'
};

/**
 * Read the current page: what it is, whether it is usable, and what to read next.
 *
 * Returns links as well as text because on lex.bg every route into a document is
 * an ordinary href — navigating by URL rather than by snapshot ref keeps the
 * whole flow independent of the accessibility tree, and costs far fewer tokens
 * than a full snapshot.
 */
export const READ_PAGE = `(limit, offset) => {
  const text = document.body ? document.body.innerText : '';
  const title = document.title || '';

  // A Cloudflare interstitial is not an error page and must not be reported as
  // one: it is the signal that a person has to take over. Several shapes of it
  // exist, so this looks for any of them.
  const cfNode = document.querySelector(
    '#challenge-form, #cf-challenge-running, .cf-turnstile, ' +
    'iframe[src*="challenges.cloudflare.com"], #challenge-stage'
  );
  const cfTitle = /just a moment|attention required|verifying you are human|checking your browser/i.test(title);
  const cfText = /verify you are human|checking your browser|needs to review the security|изчакайте|проверка на сигурността/i.test(text);
  const challenged = Boolean(cfNode) || cfTitle || cfText;

  const links = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    const label = (a.textContent || '').trim().replace(/\\s+/g, ' ');
    if (!href || !label) continue;
    if (!/(^|\\.)lex\\.bg$/.test(new URL(href, location.href).hostname)) continue;
    // Chrome resolves javascript: and # links into href too; neither is a page.
    if (/^javascript:/i.test(a.getAttribute('href') || '')) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    links.push({ label: label.slice(0, 200), href });
    if (links.length >= 250) break;
  }

  // A browser that has not been anywhere yet is idle, not broken. Chrome starts
  // on about:blank, so without this a freshly deployed box would report itself
  // blocked by an empty page and 'just lexy-status' would cry wolf.
  const onSite = /(^|\\.)lex\\.bg$/.test(location.hostname);

  // lex.bg has several distinct ways of serving something that is not the page
  // you asked for, all of them with HTTP 200, so only the body gives them away.
  // An employee that cannot tell these apart from a real document would quote a
  // stack trace as legislation or — worse — conclude that a law does not exist.
  // Each of these was observed on the live site while building this.
  let problem = null;
  if (!onSite) {
    problem = null;
  } else if (/A PHP Error was encountered|mysql_real_escape_string|Database error/i.test(text)) {
    problem = 'php-error';
  } else if (/Please,?\\s*try later|too many requests|твърде много заявки/i.test(text)) {
    problem = 'throttled';
  } else if (text.trim().length < 200 && links.length === 0) {
    // Not a known error page, but 200 OK with almost nothing on it is never a
    // legal document. Reporting it as suspect beats handing back a blank.
    problem = 'thin';
  }
  const noResults = /Няма резултати от търсенето/i.test(text);

  const start = offset || 0;
  const slice = text.slice(start, start + (limit || 15000));

  return JSON.stringify({
    url: location.href,
    title,
    onSite,
    challenged,
    problem,
    noResults,
    textLength: text.length,
    textOffset: start,
    text: slice,
    truncated: start + slice.length < text.length,
    links
  });
}`;

/**
 * Submit lex.bg's site-wide search.
 *
 * The form is a POST to /search with a `searchBox` field and a row of
 * `search_for_*` scope flags that its own JavaScript sets; submitting it
 * directly is more reliable than typing into a box whose accessibility ref
 * changes with the page. Kept because it is occasionally the only way to find
 * something, not because it is good — see the note on ENTRY_POINTS.
 */
export const SUBMIT_SEARCH = `(query, scopeField) => {
  const form = document.querySelector('#search1');
  if (!form) return JSON.stringify({ ok: false, error: 'search form not found on this page' });
  const box = form.querySelector('input[name=searchBox]');
  if (!box) return JSON.stringify({ ok: false, error: 'search box not found in the form' });
  box.value = query;
  const flag = form.querySelector('input[name=' + scopeField + ']');
  if (flag) flag.value = '1';
  form.submit();
  return JSON.stringify({ ok: true });
}`;

/** Scope flags the form carries, as read off the live page. */
export const SEARCH_SCOPES = {
  all: 'search_for_all',
  acts: 'search_for_acts',
  news: 'search_for_news',
  forums: 'search_for_forums'
};

/** Is this a URL lex-mcp is willing to open? */
export function allowedUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `not a URL: ${raw}` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `refusing scheme ${url.protocol}` };
  }
  if (url.hostname !== LEX_HOST && !url.hostname.endsWith(`.${LEX_HOST}`)) {
    return {
      ok: false,
      reason:
        `refusing ${url.hostname}: lex-mcp only opens ${LEX_HOST}. ` +
        'This employee researches Bulgarian law from lex.bg and nowhere else.'
    };
  }
  return { ok: true, url: url.href };
}

/**
 * The sentence a tool returns when Cloudflare is in the way.
 *
 * This is the whole reason the browser is a long-lived, human-viewable service
 * rather than something launched per request: the challenge cannot be answered
 * from here, so the only useful thing a tool can do is stop and say exactly
 * where a person should go and what they will find when they get there.
 */
export function challengeNotice(takeoverUrl, currentUrl) {
  return [
    'BLOCKED: Cloudflare is showing a human-verification challenge' +
      (currentUrl ? ` on ${currentUrl}` : '') + '.',
    '',
    'You cannot solve this yourself. Stop researching and tell the user, in their',
    'own language, to do exactly this:',
    '',
    `  1. Open ${takeoverUrl}`,
    '  2. Sign in with the browser account they were given',
    '  3. They will see the real browser window, already on the challenge',
    '  4. Click the "Verify you are human" checkbox and wait for the page to load',
    '  5. Tell you when it is done',
    '',
    'Then call get_browser_status to confirm the challenge is gone, and continue',
    'from where you stopped. The clearance is kept in the browser profile, so it',
    'keeps working for later questions and after a restart — a person normally',
    'has to do this only once in a long while.'
  ].join('\n');
}