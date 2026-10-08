import "server-only"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"
import { withIdentity } from "@agentonic/database/client"
import { requireVerifiedUser } from "./auth"
import { loadStyleGuides } from "./style-guide"
import {
  gmailState,
  gmailArguments,
  gmailInvocation,
  parseGmailCall,
} from "@agentonic/contracts/gmail"
import { uuid } from "@agentonic/contracts/identity"
import {
  connectionKeys,
  digest,
  seal,
  unseal,
} from "@agentonic/connectors/secrets"
import {
  exchange,
  refresh,
  profile,
  revoke,
  gmail,
  GOOGLE_SCOPES,
  GoogleError,
  type GoogleConfig,
} from "@agentonic/connectors/google"

export function googleConfig(): GoogleConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID,
    clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ??
    "http://localhost:3101/api/connections/google/callback"
  const url = new URL(redirectUri)
  // Throws for a missing or malformed key.
  const keys = connectionKeys(process.env)
  if (
    !clientId ||
    !clientSecret ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname === "localhost")) ||
    url.pathname !== "/api/connections/google/callback"
  )
    throw new Error("gmail_configuration_required")
  return { clientId, clientSecret, keys, redirectUri }
}
async function command(
  workspace: string,
  operation: string,
  payload: Record<string, unknown> = {}
) {
  uuid.parse(workspace)
  const user = await requireVerifiedUser("customer")
  return withIdentity(user.authId, workspace, async (tx) => {
    const rows = await tx.$queryRaw<
      { result: Record<string, unknown> }[]
    >`SELECT agentonic.gmail_command(${operation},${JSON.stringify(payload)}::jsonb) result`
    if (!rows[0]) throw new Error("unavailable")
    return rows[0].result
  })
}
export async function loadGmail(workspace: string, agentId: string) {
  const [connections, styleGuides] = await Promise.all([
    command(workspace, "list", { agentId: uuid.parse(agentId) }),
    loadStyleGuides(workspace, agentId),
  ])
  const state = gmailState.parse({ ...connections, styleGuides })
  let available = true
  try {
    googleConfig()
  } catch {
    available = false
  }
  return { ...state, available }
}
export async function startGmail(workspace: string, agentId: string) {
  uuid.parse(agentId)
  const config = googleConfig()
  const state = randomBytes(32).toString("hex"),
    verifier = randomBytes(32).toString("base64url"),
    connectionId = crypto.randomUUID()
  await command(workspace, "oauth.start", {
    agentId,
    connectionId,
    state: digest(state),
    verifier: seal(verifier, `oauth:${digest(state)}`, config.keys),
  })
  const jar = await cookies()
  jar.set(
    "agentonic-google-oauth",
    seal({ state, workspace }, "oauth-cookie", config.keys),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(config.redirectUri).protocol === "https:",
      maxAge: 600,
      path: "/api/connections/google/callback",
    }
  )
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  const challenge = Buffer.from(digest(verifier), "hex").toString("base64url")
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent select_account",
  }).toString()
  return url.toString()
}
export async function finishGmail(url: URL) {
  const config = googleConfig(),
    jar = await cookies(),
    cookie = jar.get("agentonic-google-oauth")?.value
  jar.set("agentonic-google-oauth", "", {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(config.redirectUri).protocol === "https:",
    maxAge: 0,
    path: "/api/connections/google/callback",
  })
  if (!cookie) throw new Error("oauth_invalid")
  const stored = unseal(cookie, "oauth-cookie", config.keys) as {
    state: string
    workspace: string
  }
  const state = url.searchParams.get("state") ?? ""
  if (
    !/^[a-f0-9]{64}$/.test(state) ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(stored.state))
  )
    throw new Error("oauth_invalid")
  const pending = await command(stored.workspace, "oauth.consume", {
    state: digest(state),
  })
  const destination = new URL(
    `/agents/${uuid.parse(pending.agentId)}`,
    config.redirectUri
  )
  destination.searchParams.set("workspace", stored.workspace)
  destination.searchParams.set("tab", "configuracion")
  if (url.searchParams.has("error")) {
    destination.searchParams.set("gmail", "cancelled")
    return destination
  }
  const code = url.searchParams.get("code")
  if (!code || code.length > 4096) throw new Error("oauth_invalid")
  const verifier = unseal(
    String(pending.verifier),
    `oauth:${digest(state)}`,
    config.keys
  )
  if (typeof verifier !== "string") throw new Error("oauth_invalid")
  const tokens = await exchange(config, code, verifier)
  try {
    const account = await profile(tokens.access_token)
    await command(stored.workspace, "oauth.finish", {
      state: digest(state),
      account,
      credential: seal(
        { refreshToken: tokens.refresh_token },
        `gmail:${pending.connectionId}`,
        config.keys
      ),
    })
  } catch {
    await revoke(tokens.refresh_token!).catch(() => false)
    throw new Error("oauth_invalid")
  }
  destination.searchParams.set("gmail", "connected")
  return destination
}
export async function gmailPermissions(
  workspace: string,
  agentId: string,
  connectionId: string,
  operations: unknown
) {
  const parsed =
    gmailState.shape.connections.element.shape.operations.parse(operations)
  await command(workspace, "permissions", {
    agentId: uuid.parse(agentId),
    connectionId: uuid.parse(connectionId),
    operations: parsed,
  })
}
export async function disconnectGmail(workspace: string, connectionId: string) {
  const config = googleConfig(),
    r = await command(workspace, "disconnect", {
      connectionId: uuid.parse(connectionId),
    })
  if (r.credential) {
    const secret = unseal(
      String(r.credential),
      `gmail:${connectionId}`,
      config.keys
    ) as { refreshToken: string }
    return { revoked: await revoke(secret.refreshToken).catch(() => false) }
  }
  return { revoked: true }
}
export async function gmailInvocations(
  workspace: string,
  conversationId: string,
  context: "staging" | "preview" = "staging"
) {
  const result = await command(workspace, "invocations", {
      conversationId: uuid.parse(conversationId),
      context,
    }),
    config = googleConfig()
  return (result.items as Record<string, unknown>[]).map((v) =>
    gmailInvocation.parse({
      ...v,
      arguments: v.argumentsCiphertext
        ? unseal(
            String(v.argumentsCiphertext),
            `invocation:${v.id}`,
            config.keys
          )
        : null,
    })
  )
}
export async function cancelGmail(workspace: string, id: string) {
  return command(workspace, "cancel", { id: uuid.parse(id) })
}
export async function confirmGmail(
  workspace: string,
  id: string,
  hash: string
) {
  uuid.parse(id)
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid")
  const config = googleConfig()
  // Refresh before consuming approval. A refresh failure has no mailbox side effect.
  const inspected = await command(workspace, "inspect", { id, hash })
  const secret = unseal(
    String(inspected.credential),
    `gmail:${inspected.connectionId}`,
    config.keys
  ) as { refreshToken: string }
  let access: string
  try {
    access = await refresh(config, secret.refreshToken)
  } catch (e) {
    if (e instanceof GoogleError && e.code === "reconnect")
      await command(workspace, "reconnect", {
        connectionId: inspected.connectionId,
      })
    throw new Error("gmail_unavailable")
  }
  const args = unseal(
    String(inspected.argumentsCiphertext),
    `invocation:${id}`,
    config.keys
  )
  const call = parseGmailCall(String(inspected.operation), args)
  if (digest(JSON.stringify(call.arguments)) !== hash)
    throw new Error("gmail_arguments_changed")
  const record = await command(workspace, "confirm", { id, hash })
  let status = "uncertain",
    result: unknown = { code: "uncertain" }
  try {
    result = await gmail(
      access,
      call.operation,
      gmailArguments[call.operation].parse(args),
      String(record.account),
      id
    )
    status = "succeeded"
  } catch (e) {
    status =
      e instanceof GoogleError && e.code !== "uncertain"
        ? "failed"
        : "uncertain"
    result = { code: status }
  }
  // Never repeat provider calls when persistence or an HTTP response is lost.
  await command(workspace, "complete", { id, status, result })
  return { status }
}
