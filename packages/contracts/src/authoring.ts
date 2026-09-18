import { z } from "zod"
import { toolGrants } from "./tools"
import { uuid } from "./identity"
export const skill = z
  .object({
    name: z
      .string()
      .max(80)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    instructions: z.string().trim().min(1).max(16000),
  })
  .strict()
export const draftContent = z
  .object({
    version: z.literal(1),
    systemPrompt: z.string().max(32000),
    skills: z.array(skill).max(20),
  })
  .strict()
  .refine(
    (v) => new Set(v.skills.map((s) => s.name)).size === v.skills.length,
    "Los nombres de las habilidades deben ser únicos."
  )
// Read schemas remain permissive so empty/new and older drafts can be corrected.
export const SYSTEM_PROMPT_MIN_CHARACTERS = 50
export const systemPromptCharacterCount = (value: string) =>
  Array.from(value.replace(/\s/gu, "")).length
export const systemPromptMinimumMessage = `Escribe al menos ${SYSTEM_PROMPT_MIN_CHARACTERS} caracteres sin contar espacios para explicar el propósito y las tareas del agente.`
export const systemPromptInput = z
  .string()
  .max(32000)
  .refine(
    (value) =>
      systemPromptCharacterCount(value) >= SYSTEM_PROMPT_MIN_CHARACTERS,
    systemPromptMinimumMessage
  )
export const editableDraftContent = draftContent.refine(
  (value) => systemPromptInput.safeParse(value.systemPrompt).success,
  { message: systemPromptMinimumMessage, path: ["systemPrompt"] }
)
export const requestedAccess = z
  .object({
    version: z.literal(1),
    collectionIds: z.array(uuid).max(20),
    tools: toolGrants,
  })
  .strict()
  .refine((v) => new Set(v.collectionIds).size === v.collectionIds.length)
const cmd = <T extends string, S extends z.ZodType>(operation: T, payload: S) =>
  z
    .object({ operation: z.literal(operation), workspaceId: uuid, payload })
    .strict()
const empty = z.object({}).strict()
export const authoringCommand = z.discriminatedUnion("operation", [
  cmd("list", empty),
  cmd("detail", z.object({ agentId: uuid }).strict()),
  cmd(
    "draft.save",
    z
      .object({
        agentId: uuid,
        revision: z.number().int().min(0).max(2147483647),
        content: editableDraftContent,
        requestedAccess,
      })
      .strict()
  ),
  cmd(
    "candidate.freeze",
    z
      .object({
        agentId: uuid,
        revision: z.number().int().positive(),
        codeReleaseId: uuid,
      })
      .strict()
  ),
  cmd(
    "submission.send",
    z
      .object({
        candidateId: uuid,
        note: z.string().max(2000),
        consent: z.literal(true),
      })
      .strict()
  ),
  cmd("submission.withdraw", z.object({ submissionId: uuid }).strict()),
  cmd(
    "collection.remove",
    z
      .object({
        collectionId: uuid,
        confirmationName: z.string().max(120),
      })
      .strict()
  ),
  cmd(
    "upload.reserve",
    z
      .object({
        collectionId: uuid,
        title: z.string().trim().min(1).max(200),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        size: z.number().int().min(1).max(10485760),
        contentType: z.enum(["text/plain", "text/markdown", "application/pdf"]),
      })
      .strict()
  ),
  ...(
    [
      "upload.complete",
      "upload.fail",
      "document.remove",
      "document.download",
    ] as const
  ).map((op) => cmd(op, z.object({ objectId: uuid }).strict())),
  cmd("review.queue", empty),
  cmd("review.open", z.object({ submissionId: uuid }).strict()),
  cmd("review.read", z.object({ submissionId: uuid, grantId: uuid }).strict()),
  cmd(
    "review.decide",
    z
      .object({
        submissionId: uuid,
        grantId: uuid,
        decision: z.enum(["in_review", "changes_requested", "rejected"]),
        feedback: z.string().trim().min(1).max(2000),
      })
      .strict()
  ),
])
export type AuthoringCommand = z.infer<typeof authoringCommand>
export const authoringResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), id: uuid.nullable(), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    code: z.enum(["conflict", "confirmation_required"]).optional(),
  }),
])
export type AuthoringResult = z.infer<typeof authoringResult>
export const workspaceView = z.object({
  creationAvailable: z.boolean().default(false),
  canCreate: z.boolean(),
  agents: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      slug: z.string(),
      description: z.string().nullable(),
      canEdit: z.boolean(),
      status: z.string(),
    })
  ),
  collections: z.array(
    z.object({ id: uuid, name: z.string(), canCurate: z.boolean() })
  ),
  templates: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      version: z.string(),
      codeReleaseId: uuid,
      codeVersion: z.string(),
    })
  ),
  pendingDeletions: z.number().int().nonnegative().default(0),
  documents: z.array(
    z.object({
      id: uuid,
      title: z.string(),
      collectionId: uuid,
      size: z.number(),
      contentType: z.string(),
      uploadStatus: z.string().nullable(),
      status: z.string(),
      canRemove: z.boolean(),
      chunkCount: z.number().int().nonnegative().default(0),
      processingError: z.string().nullable().optional(),
      processingStatus: z.string().default("not_queued"),
    })
  ),
})
export const agentListing = z.array(
  workspaceView.shape.agents.element.extend({
    configuration: z
      .object({
        promptCharacters: z.number().int().nonnegative(),
        skillsCount: z.number().int().nonnegative(),
        collectionsCount: z.number().int().nonnegative(),
        toolsCount: z.number().int().nonnegative(),
        connectionsCount: z.number().int().nonnegative(),
        liveVersion: z.string().nullable(),
        reviewVersions: z.array(
          z.object({
            version: z.string(),
            revision: z.number().int(),
            status: z.enum(["submitted", "in_review"]),
          })
        ),
      })
      .nullable(),
  })
)
export type AgentListing = z.infer<typeof agentListing>
export type WorkspaceView = z.infer<typeof workspaceView>
export const agentView = z.object({
  preparationCodeReleaseId: uuid.nullable().default(null),
  agent: z.object({
    id: uuid,
    name: z.string(),
    description: z.string().nullable(),
    templateVersionId: uuid,
  }),
  draft: z.object({
    revision: z.number(),
    content: draftContent,
    requestedAccess,
  }),
  candidates: z.array(
    z.object({
      id: uuid,
      version: z.string(),
      revision: z.number(),
      hash: z.string(),
      codeReleaseId: uuid.nullable().default(null),
      canSubmit: z.boolean().default(false),
      canPreview: z.boolean().default(false),
      previewExpiresAt: z.string().nullable().optional(),
      number: z.number().int().positive().optional(),
      createdAt: z.string().optional(),
    })
  ),
  submissions: z.array(
    z.object({
      id: uuid,
      number: z.number(),
      candidateId: uuid,
      status: z.string(),
      note: z.string().nullable(),
      decisions: z.array(
        z.object({
          decision: z.string(),
          feedback: z.string().nullable(),
          number: z.number(),
        })
      ),
    })
  ),
})
export type AgentView = z.infer<typeof agentView>
export const reviewQueue = z.array(
  z.object({
    id: uuid,
    agentName: z.string(),
    userId: uuid,
    userName: z.string(),
    userEmail: z.string().nullable(),
    versionNumber: z.number().int().positive(),
    canOpen: z.boolean(),
    approvalReason: z.string().optional(),
    approvalExpiresAt: z.string().nullable().optional(),
    deploymentStatus: z.string().optional(),
    number: z.number(),
    status: z.string(),
  })
)
export const reviewListing = z.array(
  reviewQueue.element.extend({ workspaceId: uuid, workspaceName: z.string() })
)
export type ReviewListing = z.infer<typeof reviewListing>

export const reviewView = z.object({
  id: uuid,
  grantId: uuid,
  number: z.number(),
  agentName: z.string(),
  note: z.string().nullable(),
  content: draftContent,
  requestedAccess: z
    .object({
      collectionIds: z.array(uuid),
      tools: toolGrants.optional(),
    })
    .passthrough(),
  hash: z.string(),
  status: z.string(),
})
export type ReviewView = z.infer<typeof reviewView>
export type FormResult = {
  ok: boolean
  message: string
  href?: string
  requiresConfirmationName?: boolean
}
export const submissionLabels: Record<string, string> = {
  submitted: "Enviada",
  in_review: "En revisión",
  changes_requested: "Cambios solicitados",
  rejected: "Rechazada",
  withdrawn: "Retirada",
  approved: "Aprobada",
  revoked: "Revocada",
}
