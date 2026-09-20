// Dev Tunnels can rewrite Origin to localhost while retaining the public
// x-forwarded-host. Opt in to one exact tunnel; never trust all tunnel tenants.
export function customerDevOrigins(mode?: string, origin?: string) {
  if (mode !== "development" || !origin) return {}
  const url = new URL(origin)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.hostname.includes("*")
  ) {
    throw new Error("AGENTONIC_CUSTOMER_DEV_ORIGIN must be one exact HTTPS origin")
  }
  return {
    allowedDevOrigins: [url.hostname],
    experimental: {
      serverActions: {
        allowedOrigins: [url.host, "localhost:3101", "127.0.0.1:3101"],
      },
    },
  }
}
