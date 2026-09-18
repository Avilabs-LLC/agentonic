import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex")
function key(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error("gmail_configuration_required")
  return Buffer.from(value, "hex")
}
// Associated data binds ciphertext to its purpose and immutable record identity.
export function seal(value: unknown, binding: string, secret: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(secret), iv)
  cipher.setAAD(Buffer.from(binding))
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ])
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    bytes.toString("base64url"),
  ].join(".")
}
export function unseal(
  value: string,
  binding: string,
  secret: string
): unknown {
  try {
    const [v, iv, tag, bytes, extra] = value.split(".")
    if (v !== "v1" || !iv || !tag || !bytes || extra) throw new Error()
    const cipher = createDecipheriv(
      "aes-256-gcm",
      key(secret),
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
  } catch {
    throw new Error("gmail_secret_unavailable")
  }
}
