import "server-only"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"
import { withIdentity } from "@agentonic/database/client"
import { requireVerifiedUser } from "./auth"
import { accountShared, googleConfig } from "./gmail"
import {
  driveCredential,
  driveFileId,
  driveInvocation,
  driveKnowledgeFile,
  driveKnowledgeState,
  driveState,
  parseDriveProposal,
  pickedFileIds,
  pickerSession,
} from "@agentonic/contracts/drive"
import { uuid } from "@agentonic/contracts/identity"
import { digest, seal, unseal } from "@agentonic/connectors/secrets"
import {
  exchange,
  refresh,
  revoke,
  GoogleError,
  type GoogleConfig,
} from "@agentonic/connectors/google"
import {
  DRIVE_OAUTH_SCOPES,
  DriveFileError,
  docText,
  driveAccount,
  driveWrite,
  fileMetadata,
  pickerAppId,
  pickerToken,
} from "@agentonic/connectors/drive"

// Google Drive for the customer app (architecture §62). The same Google client
// and callback as Gmail; its own cookie, state rows and sealed credentials.
const COOKIE = "agentonic-google-drive-oauth"
const CALLBACK = "/api/connections/google/callback"
/** The Picker's browser key and the Cloud project number, when configured. */
export function pickerConfig() {
  const apiKey = process.env.GOOGLE_PICKER_API_KEY,
    appId = pickerAppId(
      process.env.GOOGLE_CLOUD_PROJECT_NUMBER,
      process.env.GOOGLE_CLIENT_ID
    )
  if (!apiKey || !appId) throw new Error("picker_configuration_required")
  return { apiKey, appId }
}
const configured = (check: () => unknown) => {
  try {
    check()
    return true
  } catch {
    return false
  }
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
    >`SELECT agentonic.drive_command(${operation},${JSON.stringify(payload)}::jsonb) result`
    if (!rows[0]) throw new Error("unavailable")
    return rows[0].result
  })
}
const sealedRefresh = (config: GoogleConfig, credential: unknown, id: string) =>
  driveCredential.parse(unseal(String(credential), `drive:${id}`, config.keys))
    .refreshToken
/** A fresh access token; a refused refresh marks the connection for reconnection. */
async function access(
  workspace: string,
  config: GoogleConfig,
  connectionId: string,
  credential: unknown
) {
  try {
    return await refresh(
      config,
      sealedRefresh(config, credential, connectionId)
    )
  } catch (e) {
    if (e instanceof GoogleError && e.code === "reconnect")
      await command(workspace, "reconnect", { connectionId })
    throw new Error("drive_unavailable")
  }
}

export async function loadDrive(workspace: string, agentId: string) {
  const state = driveState.parse(
    await command(workspace, "list", { agentId: uuid.parse(agentId) })
  )
  return {
    ...state,
    available: configured(googleConfig),
    picker: configured(pickerConfig),
  }
}
export async function loadDriveKnowledge(workspace: string) {
  const [connections, files] = await Promise.all([
    command(workspace, "knowledge.connections"),
    command(workspace, "knowledge.list"),
  ])
  return {
    ...driveKnowledgeState.parse(connections),
    files: driveKnowledgeFile.array().parse(files.files),
    available: configured(googleConfig),
    picker: configured(pickerConfig),
  }
}

// Connecting ---------------------------------------------------------------------
export async function startDrive(
  workspace: string,
  purpose: "tools" | "knowledge",
  agentId?: string
) {
  const config = googleConfig()
  const state = randomBytes(32).toString("hex"),
    verifier = randomBytes(32).toString("base64url"),
    connectionId = crypto.randomUUID()
  await command(workspace, "oauth.start", {
    purpose,
    ...(purpose === "tools" ? { agentId: uuid.parse(agentId) } : {}),
    connectionId,
    state: digest(state),
    verifier: seal(verifier, `oauth:${digest(state)}`, config.keys),
  })
  const jar = await cookies()
  jar.set(
    COOKIE,
    seal({ state, workspace }, "drive-oauth-cookie", config.keys),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(config.redirectUri).protocol === "https:",
      maxAge: 600,
      path: CALLBACK,
    }
  )
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  const challenge = Buffer.from(digest(verifier), "hex").toString("base64url")
  // Only drive.file, and never the scopes granted earlier for Gmail.
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: DRIVE_OAUTH_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent select_account",
  }).toString()
  return url.toString()
}
/** Whether a callback belongs to a Drive connection started in this browser. */
export async function isDriveCallback(url: URL) {
  const cookie = (await cookies()).get(COOKIE)?.value
  if (!cookie) return false
  try {
    const stored = unseal(
      cookie,
      "drive-oauth-cookie",
      googleConfig().keys
    ) as {
      state: string
    }
    const state = url.searchParams.get("state") ?? ""
    return (
      /^[a-f0-9]{64}$/.test(state) &&
      timingSafeEqual(Buffer.from(state), Buffer.from(stored.state))
    )
  } catch {
    return false
  }
}
export async function finishDrive(url: URL) {
  const config = googleConfig(),
    jar = await cookies(),
    cookie = jar.get(COOKIE)?.value
  jar.set(COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(config.redirectUri).protocol === "https:",
    maxAge: 0,
    path: CALLBACK,
  })
  if (!cookie) throw new Error("oauth_invalid")
  const stored = unseal(cookie, "drive-oauth-cookie", config.keys) as {
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
  const destination =
    pending.purpose === "tools"
      ? new URL(`/agents/${uuid.parse(pending.agentId)}`, config.redirectUri)
      : new URL("/knowledge", config.redirectUri)
  destination.searchParams.set("workspace", stored.workspace)
  if (pending.purpose === "tools")
    destination.searchParams.set("tab", "configuracion")
  if (url.searchParams.has("error")) {
    destination.searchParams.set("drive", "cancelled")
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
  const tokens = await exchange(config, code, verifier, DRIVE_OAUTH_SCOPES)
  // A failed connection never revokes at Google: revocation would end every
  // grant the person gave this project, Gmail's included.
  const account = await driveAccount(tokens.access_token)
  const target = uuid.parse(
    (
      await command(stored.workspace, "oauth.target", {
        state: digest(state),
        account,
      })
    ).connectionId
  )
  await command(stored.workspace, "oauth.finish", {
    state: digest(state),
    account,
    connectionId: target,
    credential: seal(
      { refreshToken: tokens.refresh_token },
      `drive:${target}`,
      config.keys
    ),
  })
  destination.searchParams.set("drive", "connected")
  return destination
}
/**
 * Disconnects a connection, then revokes its token at Google unless another
 * Agentonic connection still holds the same account: Google's revocation ends
 * every grant to the project, so it would also end that one.
 */
export async function disconnectDrive(workspace: string, connectionId: string) {
  const config = googleConfig()
  const r = await command(workspace, "disconnect", {
    connectionId: uuid.parse(connectionId),
  })
  if (!r.credential) return { revoked: false }
  if (await accountShared(workspace, "drive", connectionId))
    return { revoked: false }
  return {
    revoked: await revoke(
      sealedRefresh(config, r.credential, connectionId)
    ).catch(() => false),
  }
}

// Picking files ----------------------------------------------------------------
/** What Google's Picker needs for one of the member's own connected accounts. */
export async function drivePicker(workspace: string, connectionId: string) {
  const config = googleConfig(),
    picker = pickerConfig()
  const c = await command(workspace, "credential", {
    connectionId: uuid.parse(connectionId),
  })
  let token: string
  try {
    token = (
      await pickerToken(
        config,
        sealedRefresh(config, c.credential, connectionId)
      )
    ).token
  } catch (e) {
    if (e instanceof GoogleError && e.code === "reconnect")
      await command(workspace, "reconnect", { connectionId })
    throw new Error("drive_unavailable")
  }
  return pickerSession.parse({
    token,
    apiKey: picker.apiKey,
    appId: picker.appId,
    account: c.account,
  })
}
const refusals: Record<string, string> = {
  unsupported: "Formato no compatible",
  too_large: "Supera 10 MB",
  trashed: "Está en la papelera",
  not_found: "Sin acceso en Drive",
  no_access: "Sin acceso en Drive",
}
/**
 * Checks every picked file with Drive itself through the connection, so only
 * files Drive really shares with Agentonic, in a supported format, are kept.
 * Names and types come from Drive, never from the browser.
 */
async function verifyPicked(
  workspace: string,
  connectionId: string,
  fileIds: unknown
) {
  const config = googleConfig()
  const ids = pickedFileIds.parse(fileIds)
  const c = await command(workspace, "credential", { connectionId })
  const token = await access(workspace, config, connectionId, c.credential)
  const accepted: { fileId: string; name: string; mimeType: string }[] = []
  const refused: { fileId: string; reason: string }[] = []
  for (const fileId of new Set(ids)) {
    try {
      const meta = await fileMetadata(token, fileId)
      accepted.push({
        fileId,
        name: meta.name.slice(0, 500),
        mimeType: meta.mimeType,
      })
    } catch (e) {
      if (!(e instanceof DriveFileError)) throw new Error("drive_unavailable")
      refused.push({
        fileId,
        reason: refusals[e.problem] ?? "Sin acceso en Drive",
      })
    }
  }
  return { accepted, refused }
}
export async function addDriveFiles(
  workspace: string,
  agentId: string,
  connectionId: string,
  fileIds: unknown
) {
  uuid.parse(connectionId)
  const { accepted, refused } = await verifyPicked(
    workspace,
    connectionId,
    fileIds
  )
  if (accepted.length) {
    const r = await command(workspace, "files.add", {
      agentId: uuid.parse(agentId),
      connectionId,
      files: accepted,
    })
    if (r.ok === false) return { ok: false, code: String(r.code) }
  }
  return { ok: true, added: accepted.length, refused }
}
export async function removeDriveFile(
  workspace: string,
  agentId: string,
  connectionId: string,
  fileId: unknown
) {
  await command(workspace, "files.remove", {
    agentId: uuid.parse(agentId),
    connectionId: uuid.parse(connectionId),
    fileId: driveFileId.parse(fileId),
  })
  return { ok: true }
}
export async function drivePermissions(
  workspace: string,
  agentId: string,
  connectionId: string,
  operations: unknown
) {
  await command(workspace, "permissions", {
    agentId: uuid.parse(agentId),
    connectionId: uuid.parse(connectionId),
    operations:
      driveState.shape.connections.element.shape.operations.parse(operations),
  })
  return { ok: true }
}

// Proposed writes ----------------------------------------------------------------
export async function driveInvocations(
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
    driveInvocation.parse({
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
export async function cancelDrive(workspace: string, id: string) {
  return command(workspace, "cancel", { id: uuid.parse(id) })
}
const hashed = (id: string, hash: string) => {
  uuid.parse(id)
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid")
}
/** The Doc's text now, beside a proposed update, without consuming the approval. */
export async function driveCurrent(
  workspace: string,
  id: string,
  hash: string
) {
  hashed(id, hash)
  const config = googleConfig()
  const inspected = await command(workspace, "inspect", { id, hash })
  if (inspected.operation !== "drive.docs.update" || !inspected.fileId)
    throw new Error("invalid")
  const token = await access(
    workspace,
    config,
    String(inspected.connectionId),
    inspected.credential
  )
  try {
    const current = await docText(token, driveFileId.parse(inspected.fileId))
    return { ok: true, ...current, text: current.text.slice(0, 20000) }
  } catch (e) {
    if (e instanceof DriveFileError) return { ok: false, code: e.problem }
    throw new Error("drive_unavailable")
  }
}
export async function confirmDrive(
  workspace: string,
  id: string,
  hash: string
) {
  hashed(id, hash)
  const config = googleConfig()
  // Refresh before consuming the approval: a failed refresh changes nothing.
  const inspected = await command(workspace, "inspect", { id, hash })
  const token = await access(
    workspace,
    config,
    String(inspected.connectionId),
    inspected.credential
  )
  const args = unseal(
    String(inspected.argumentsCiphertext),
    `invocation:${id}`,
    config.keys
  )
  const call = parseDriveProposal(String(inspected.operation), args)
  if (digest(JSON.stringify(call.arguments)) !== hash)
    throw new Error("drive_arguments_changed")
  await command(workspace, "confirm", { id, hash })
  let status = "uncertain",
    result: Record<string, unknown> = { code: "uncertain" }
  try {
    const file = await driveWrite(token, call.operation, call.arguments)
    status = "succeeded"
    result = { fileId: file.fileId, name: file.name }
  } catch (e) {
    status =
      e instanceof GoogleError && e.code !== "uncertain"
        ? "failed"
        : "uncertain"
    result = {
      code:
        e instanceof DriveFileError
          ? e.problem
          : status === "failed"
            ? "failed"
            : "uncertain",
    }
  }
  // Never repeat the provider call when recording the outcome fails.
  await command(workspace, "complete", { id, status, result })
  return { status, code: result.code }
}

// Knowledge ----------------------------------------------------------------------
export async function importDriveKnowledge(
  workspace: string,
  connectionId: string,
  collectionId: string,
  fileIds: unknown
) {
  uuid.parse(connectionId)
  const { accepted, refused } = await verifyPicked(
    workspace,
    connectionId,
    fileIds
  )
  if (!accepted.length) return { ok: true, added: 0, refused }
  const r = await command(workspace, "knowledge.add", {
    connectionId,
    collectionId: uuid.parse(collectionId),
    files: accepted,
  })
  if (r.ok === false) return { ok: false, code: String(r.code) }
  return { ok: true, added: Number(r.added), refused }
}
export async function driveKnowledgeAction(
  workspace: string,
  operation: "knowledge.sync" | "knowledge.apply" | "knowledge.remove",
  sourceId: string
) {
  return command(workspace, operation, { sourceId: uuid.parse(sourceId) })
}
