/** AI Shell distribution (D20 cookie-header slim): the desktop session-cookie derivation. */

import { createHash } from 'node:crypto'

/**
 * AI Shell distribution (D20 cookie-header slim): replicate the official
 * browser-auth cookieName derivation (COOKIE_PREFIX + base64url(sha256(authority)))
 * so the desktop can address the exact cookie the Host session will read.
 * The authority spelling mirrors the official requestAudience: the Host
 * header's host[:port], verbatim.
 */
export function desktopSessionCookieName(hostUrl: string): string {
  const url = new URL(hostUrl)
  const authority = url.host
  return 'dsh-auth-' + createHash('sha256').update(authority).digest().toString('base64url')
}

