import { isDeepStrictEqual } from "node:util"
import { createHash } from "node:crypto"
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
  existsSync,
  realpathSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { z } from "zod"
import { verifyRuntime } from "./runtime"
export const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex")
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const installation = z.object({
  manifestJson: z.string(),
  manifestHash: hash,
  configurationJson: z.string(),
  configuration: z
    .object({
      version: z.literal(1),
      systemPrompt: z.string().max(32000),
      skills: z
        .array(
          z.object({
            name: z
              .string()
              .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
              .max(80),
            instructions: z.string().max(16000),
          })
        )
        .max(20),
    })
    .strict(),
})
export const manifestSchema = z.object({
  version: z.literal(1),
  deploymentId: z.uuid(),
  workspaceId: z.uuid(),
  agentId: z.uuid(),
  environment: z.enum(["local", "azure_staging"]),
  approvalId: z.uuid(),
  configurationId: z.uuid(),
  configurationHash: hash,
  accessHash: hash,
  assetHash: hash,
  assets: z.array(
    z.object({
      path: z.string().regex(/^(prompts\/system|skills\/[a-z0-9-]+)\.md$/),
      sha256: hash,
    })
  ),
  runtime: z.object({
    artifactSha256: hash,
    gitCommit: z.string(),
    manifest: z.unknown(),
  }),
})
export function deploymentDirectory(
  root: string,
  manifest: z.infer<typeof manifestSchema>
) {
  return join(
    resolve(root),
    manifest.workspaceId,
    manifest.agentId,
    manifest.environment,
    "releases",
    manifest.deploymentId
  )
}
export function prepareInstallation(
  value: unknown,
  root: string,
  runtimeRoot: string
) {
  const input = installation.parse(value)
  if (digest(input.manifestJson) !== input.manifestHash)
    throw new Error("runtime_mismatch")
  const manifest = manifestSchema.parse(JSON.parse(input.manifestJson))
  if (
    digest(input.configurationJson) !== manifest.configurationHash ||
    !isDeepStrictEqual(JSON.parse(input.configurationJson), input.configuration)
  )
    throw new Error("runtime_mismatch")
  verifyRuntime(manifest.runtime, runtimeRoot)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const destination = deploymentDirectory(realpathSync(root), manifest)
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  // Refuse symlinked parents before writing private generated assets.
  if (realpathSync(destination) !== resolve(destination))
    throw new Error("unsafe_release_path")
  const files: Record<string, string> = {
    "manifest.json": input.manifestJson,
    "prompts/system.md": input.configuration.systemPrompt,
  }
  for (const skill of input.configuration.skills)
    files[`skills/${skill.name}.md`] = skill.instructions
  for (const asset of manifest.assets)
    if (digest(files[asset.path] ?? "") !== asset.sha256)
      throw new Error("runtime_mismatch")
  for (const [path, content] of Object.entries(files)) {
    const target = join(destination, path)
    mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 })
    if (existsSync(target)) {
      if (
        lstatSync(target).isSymbolicLink() ||
        readFileSync(target, "utf8") !== content
      )
        throw new Error("immutable_release")
    } else writeFileSync(target, content, { mode: 0o400, flag: "wx" })
  }
  const runtime = join(destination, "runtime")
  if (!existsSync(runtime))
    symlinkSync(
      join(resolve(runtimeRoot), manifest.runtime.artifactSha256),
      runtime
    )
  if (
    realpathSync(runtime) !==
    realpathSync(join(runtimeRoot, manifest.runtime.artifactSha256))
  )
    throw new Error("runtime_mismatch")
  return { manifest, destination, manifestHash: input.manifestHash }
}
export function switchCurrent(
  root: string,
  manifest: z.infer<typeof manifestSchema>
) {
  const base = resolve(deploymentDirectory(root, manifest), "../..")
  const temporary = join(base, `.current-${manifest.deploymentId}`)
  if (existsSync(temporary)) {
    if (
      !lstatSync(temporary).isSymbolicLink() ||
      readlinkSync(temporary) !== `releases/${manifest.deploymentId}`
    )
      throw new Error("interrupted_switch")
    unlinkSync(temporary)
  }
  symlinkSync(`releases/${manifest.deploymentId}`, temporary)
  renameSync(temporary, join(base, "current"))
}
