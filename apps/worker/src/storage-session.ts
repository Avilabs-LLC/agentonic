// Storage access for the knowledge worker without the Supabase secret key.
// The worker signs in as its own Auth account (agentonic_service=storage_worker
// in app_metadata, set by setup-storage-identity.mjs). Storage rules then let
// that account read a document only while an ingestion or purge job for it
// holds a live lease, and delete one only during its purge (migration 42).
import { z } from "zod"

const session = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
})

export class StorageSession {
  private token: { value: string; until: number } | undefined
  private signingIn: Promise<void> | undefined
  constructor(
    readonly url: string,
    private readonly publishableKey: string,
    private readonly email: string,
    private readonly password: string,
    private readonly now: () => number = Date.now
  ) {}

  /** Request headers for Storage; signs in again shortly before the token expires. */
  async headers(signal: AbortSignal): Promise<Record<string, string>> {
    if (!this.token || this.now() >= this.token.until) {
      // Jobs running side by side wait for one sign-in rather than each making one.
      this.signingIn ??= this.signIn().finally(() => {
        this.signingIn = undefined
      })
      await new Promise<void>((resolve, reject) => {
        const stop = () => reject(new Error("storage_unavailable"))
        if (signal.aborted) return stop()
        signal.addEventListener("abort", stop, { once: true })
        this.signingIn!.then(resolve, reject).finally(() =>
          signal.removeEventListener("abort", stop)
        )
      })
    }
    return {
      apikey: this.publishableKey,
      Authorization: `Bearer ${this.token!.value}`,
    }
  }

  private async signIn() {
    let response: Response
    try {
      response = await fetch(`${this.url}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          apikey: this.publishableKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: this.email, password: this.password }),
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      throw new Error("storage_unavailable")
    }
    const parsed = session.safeParse(
      response.ok ? await response.json().catch(() => null) : null
    )
    if (!parsed.success) throw new Error("storage_unavailable")
    this.token = {
      value: parsed.data.access_token,
      // Two minutes' margin, never less than half the token's life.
      until:
        this.now() +
        Math.max(
          parsed.data.expires_in * 500,
          (parsed.data.expires_in - 120) * 1000
        ),
    }
  }
}

/** The worker's storage account from its configuration, or none if it is incomplete. */
export function storageSession(env: Record<string, string | undefined>) {
  const url = env.SUPABASE_URL,
    key = env.SUPABASE_PUBLISHABLE_KEY,
    email = env.AGENTONIC_STORAGE_EMAIL,
    password = env.AGENTONIC_STORAGE_PASSWORD
  return url && key && email && password
    ? new StorageSession(new URL(url).origin, key, email, password)
    : undefined
}
