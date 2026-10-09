// Response headers for both apps (architecture §53). Pages may run only the
// app's own scripts carrying this request's nonce; the outside destinations are
// Google's consent screen, where the Gmail and Drive connection forms
// redirect, and Google's Picker, which the app's own script loads on demand
// (allowed by 'strict-dynamic') and which renders in a frame from Google
// (architecture §62).
import type { AppKind } from "@agentonic/contracts/identity"
export function contentSecurityPolicy(nonce: string) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src https://docs.google.com https://drive.google.com",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self' https://accounts.google.com",
    "frame-ancestors 'none'",
  ].join("; ")
}
/**
 * Pages that open either app never keep a handle on it. The customer app lets
 * its own popups keep theirs: when a browser withholds Google's cookies from
 * the Picker's frame (Brave, Safari), Google reopens the Picker in a popup
 * from that frame, and the popup hands the picked files back to it. Under
 * `same-origin` a browser cuts that link (architecture §62).
 */
export const openerPolicy = {
  customer: "same-origin-allow-popups",
  admin: "same-origin",
} as const satisfies Record<AppKind, string>
export function securityHeaders(
  production: boolean,
  app: AppKind
): [string, string][] {
  return [
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "DENY"],
    ["Referrer-Policy", "same-origin"],
    ["Cross-Origin-Opener-Policy", openerPolicy[app]],
    [
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    ],
    // Browsers ignore HSTS over plain HTTP; hosted names always answer over TLS.
    ...(production
      ? [
          [
            "Strict-Transport-Security",
            "max-age=63072000; includeSubDomains",
          ] as [string, string],
        ]
      : []),
  ]
}
/** A fresh nonce per page request (128 random bits, base64). */
export function nonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}
/** The nonce in a request's policy, for the few inline scripts a page renders itself. */
export function nonceOf(policy: string | null) {
  return policy?.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1]
}
