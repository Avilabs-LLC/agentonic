// The public site (architecture §85). Caddy sends agentonic.avilabs.tech to
// the customer app; the app's proxy turns that host's root into the site's
// pages, which are also reachable under their own paths on the app's host.
export const SITE_HOSTNAME = "agentonic.avilabs.tech"
/** Where a request to the site's host is rewritten, or null to serve it as is. */
export function siteRewrite(host: string | null, pathname: string) {
  if (host?.toLowerCase().split(":")[0] !== SITE_HOSTNAME) return null
  if (pathname === "/") return "/sitio"
  if (pathname === "/en") return "/sitio/en"
  return null
}
