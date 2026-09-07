/**
 * Decide whether a `message` event really came from our own OAuth popup.
 *
 * Lives in its own module — no React, no antd — so the check is unit-testable
 * in a plain Node environment. It is the control that stops an arbitrary page
 * from spoofing the result of a Microsoft connection, and a security control
 * that cannot be asserted on is one nobody can prove still works.
 *
 * Order matters: provenance is established before the payload is read at all.
 *
 *  1. `ev.origin` must equal our own origin. The callback page is served by
 *     this same NocoBase instance at the configured redirect URI.
 *  2. `ev.source` must be the popup handle we opened, so a same-origin iframe
 *     cannot stand in for it.
 *  3. Only then does `data.source` matter, and only as a payload-shape tag. On
 *     its own it authenticates nothing, because anyone can write it — which is
 *     precisely why checking it alone was a vulnerability.
 */
export function isTrustedOAuthMessage(
  ev: { origin?: string; source?: unknown; data?: unknown } | null | undefined,
  expectedOrigin: string,
  expectedSource: unknown,
): boolean {
  if (!ev) return false;
  if (ev.origin !== expectedOrigin) return false;
  // A null/undefined expectedSource must never match a null/undefined
  // ev.source — that would let a message with no source through.
  if (!expectedSource || ev.source !== expectedSource) return false;
  const d: any = ev.data;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  return d.source === 'nocobase-ms-oauth';
}
