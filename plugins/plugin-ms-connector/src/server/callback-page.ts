/**
 * The HTML served by `msConnections:callback` — the page Microsoft redirects
 * the OAuth popup to.
 *
 * Kept in its own module, free of any `@nocobase/*` import, for two reasons:
 * the page has nothing to do with the Plugin class, and it makes the two
 * security controls in here directly unit-testable without booting a NocoBase
 * server. Those controls are the `postMessage` target origin and the escaping
 * of interpolated values into an inline <script>; see tests/callback-page.test.ts.
 */

export const CALLBACK_HTML = (payload: {
  status: 'success' | 'error';
  email?: string;
  message?: string;
}) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Microsoft connection</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#f6f8fa;color:#111;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#fff;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.08);padding:32px;max-width:420px;text-align:center}
h1{margin:0 0 8px;font-size:20px}
p{margin:0 0 16px;color:#555}
.ok{color:#16a34a}.err{color:#b91c1c}</style>
</head><body>
<div class="card">
  <h1 class="${payload.status === 'success' ? 'ok' : 'err'}">
    ${payload.status === 'success' ? 'Microsoft account connected' : 'Connection failed'}
  </h1>
  <p>${payload.email ? `Signed in as <b>${escapeHtml(payload.email)}</b>.` : ''}${payload.message ? escapeHtml(payload.message) : ''}</p>
  <p>You can close this window.</p>
</div>
<script>
  try {
    if (window.opener) {
      // targetOrigin is window.location.origin, never '*'. This page is served
      // by the NocoBase server at the configured redirect URI, and the opener
      // is the NocoBase UI on that same origin, so restricting delivery costs
      // nothing. With '*' the payload — which carries the user's Microsoft
      // email address — would be readable by whatever document happened to be
      // the opener, including a hostile page that opened the app in a popup.
      //
      // If a deployment ever serves the UI and the redirect URI from different
      // origins, the browser drops this message and the opener falls back to
      // its popup-closed path; msConnections:status is re-fetched either way,
      // so the connection state stays correct. Losing a toast is the right
      // failure mode for a cross-origin mismatch.
      window.opener.postMessage(${jsonForScript({ source: 'nocobase-ms-oauth', ...payload })}, window.location.origin);
    }
  } catch (e) {}
  setTimeout(() => { try { window.close(); } catch (e) {} }, 800);
</script>
</body></html>`;

function escapeHtml(v: string): string {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * JSON for embedding inside an inline <script> block.
 *
 * `JSON.stringify` alone is not safe here: it does not escape `<`, so a value
 * containing `</script>` would terminate the block early and turn the rest of
 * the payload into markup. `msEmail` comes from Microsoft Graph's `/me`
 * response rather than from this codebase, so it is not ours to trust.
 * U+2028/U+2029 are also escaped — they are valid JSON but illegal raw in a
 * JavaScript string literal, and would otherwise be a syntax error rather
 * than a vulnerability.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
