import net from "node:net"
import tls from "node:tls"
import { readFileSync } from "node:fs"
// Prisma's macOS native TLS backend does not honor this Supabase CA like node-pg.
// Bind only to loopback; every off-machine byte travels through verified TLS.
// This proxy neither authenticates users nor interprets/stores SQL or credentials.
export async function postgresTlsBridge(remoteUrl, caFile) {
  const remote = new URL(remoteUrl)
  const ca = readFileSync(caFile, "utf8")
  const sockets = new Set()
  let failed = false
  const server = net.createServer((local) => {
    local.pause()
    sockets.add(local)
    const upstream = net.connect({
      host: remote.hostname,
      port: Number(remote.port || 5432),
    })
    sockets.add(upstream)
    function close() {
      local.destroy()
      upstream.destroy()
    }
    local.on("error", close)
    local.on("close", () => {
      sockets.delete(local)
      upstream.destroy()
    })
    upstream.on("error", () => {
      failed = true
      close()
    })
    upstream.on("close", () => sockets.delete(upstream))
    upstream.setTimeout(15_000, () => {
      failed = true
      close()
    })
    upstream.once("connect", () => {
      const request = Buffer.alloc(8)
      request.writeInt32BE(8, 0)
      request.writeInt32BE(80877103, 4)
      upstream.write(request)
    })
    upstream.once("data", (answer) => {
      if (answer.length !== 1 || answer[0] !== 83) {
        failed = true
        close()
        return
      }
      upstream.setTimeout(0)
      upstream.pause()
      const secure = tls.connect({
        socket: upstream,
        servername: remote.hostname,
        ca,
        rejectUnauthorized: true,
      })
      sockets.add(secure)
      secure.on("error", () => {
        failed = true
        close()
      })
      secure.on("close", () => {
        sockets.delete(secure)
        local.destroy()
      })
      secure.once("secureConnect", () => {
        local.pipe(secure)
        secure.pipe(local)
        local.resume()
      })
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  return {
    port: address.port,
    failed: () => failed,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
