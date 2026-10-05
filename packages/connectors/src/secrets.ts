import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex")

/**
 * The connection keys a holder has. The active key seals; every key opens
 * what it sealed, so a new key can be added everywhere before it is used and
 * an old one kept until no stored value needs it.
 */
export type Keyring = {
  readonly active: string
  readonly keys: ReadonlyMap<string, Buffer>
}
const hex = /^[a-f0-9]{64}$/
/** A key's public name: a short hash of it, never the key itself. */
export function keyId(key: string) {
  if (!hex.test(key)) throw new Error("gmail_configuration_required")
  return createHash("sha256")
    .update("agentonic-connection-key\0")
    .update(Buffer.from(key, "hex"))
    .digest("hex")
    .slice(0, 16)
}
export function keyring(
  active: string,
  standby: string | readonly string[] = []
): Keyring {
  const others =
    typeof standby === "string"
      ? standby
          .split(",")
          .map((key) => key.trim())
          .filter(Boolean)
      : standby
  const keys = new Map<string, Buffer>()
  for (const key of [active, ...others])
    keys.set(keyId(key), Buffer.from(key, "hex"))
  return { active: keyId(active), keys }
}
/** The keyring a process configures: the active key plus any standby keys. */
export function connectionKeys(env: Record<string, string | undefined>) {
  return keyring(
    env.AGENTONIC_CONNECTION_KEY ?? "",
    env.AGENTONIC_CONNECTION_STANDBY_KEYS ?? ""
  )
}
const ring = (keys: Keyring | string) =>
  typeof keys === "string" ? keyring(keys) : keys

// Associated data binds ciphertext to its purpose and immutable record identity.
// v2 values name their key; v1 values (before key names) name none.
export function seal(value: unknown, binding: string, keys: Keyring | string) {
  const k = ring(keys),
    iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", k.keys.get(k.active)!, iv)
  cipher.setAAD(Buffer.from(binding))
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ])
  return [
    "v2",
    k.active,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    bytes.toString("base64url"),
  ].join(".")
}
function open(
  key: Buffer,
  iv: string,
  tag: string,
  bytes: string,
  binding: string
) {
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64url")
  )
  cipher.setAAD(Buffer.from(binding))
  cipher.setAuthTag(Buffer.from(tag, "base64url"))
  return JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(bytes, "base64url")),
      cipher.final(),
    ]).toString()
  ) as unknown
}
export function unseal(
  value: string,
  binding: string,
  keys: Keyring | string
): unknown {
  try {
    const k = ring(keys)
    const parts = value.split(".")
    if (parts[0] === "v2" && parts.length === 5) {
      const [, id, iv, tag, bytes] = parts as [
        string,
        string,
        string,
        string,
        string,
      ]
      const key = k.keys.get(id)
      if (!key || !iv || !tag || !bytes) throw new Error()
      return open(key, iv, tag, bytes, binding)
    }
    if (parts[0] === "v1" && parts.length === 4) {
      const [, iv, tag, bytes] = parts as [string, string, string, string]
      if (!iv || !tag || !bytes) throw new Error()
      // The tag authenticates only under the key that sealed it.
      for (const key of k.keys.values()) {
        try {
          return open(key, iv, tag, bytes, binding)
        } catch {
          /* Not this key. */
        }
      }
    }
    throw new Error()
  } catch {
    throw new Error("gmail_secret_unavailable")
  }
}
/** The key a stored value names, or "v1" for values sealed before keys had names. */
export function sealedWith(value: string) {
  const [version, id] = value.split(".")
  return version === "v2" && id ? id : "v1"
}
