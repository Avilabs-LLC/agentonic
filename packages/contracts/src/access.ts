import { z } from "zod"
import { uuid } from "./identity"

const name = z.string().trim().min(1).max(120)
const slug = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
const description = z.string().trim().max(2000).optional()
const expiresAt = z.iso.datetime({ offset: true })
export const supportScope = z
  .object({
    version: z.literal(1),
    resources: z
      .array(
        z
          .object({
            type: z.enum(["agent", "collection"]),
            id: uuid,
            operations: z.tuple([z.literal("read")]),
          })
          .strict()
      )
      .min(1)
      .max(50),
  })
  .strict()
const command = <T extends string, S extends z.ZodType>(
  operation: T,
  payload: S
) =>
  z
    .object({ operation: z.literal(operation), workspaceId: uuid, payload })
    .strict()
const empty = z.object({}).strict()
export const accessCommand = z.discriminatedUnion("operation", [
  command("member.list", empty),
  command("invite.list", empty),
  command(
    "agent.create",
    z
      .object({
        name,
        slug,
        description,
        ownerMemberId: uuid.optional(),
        templateVersionId: uuid,
      })
      .strict()
  ),
  command("collection.create", z.object({ name, slug, description }).strict()),
  command(
    "agent.share",
    z
      .object({
        agentId: uuid,
        memberId: uuid,
        role: z.enum(["maintainer", "operator", "viewer"]),
      })
      .strict()
  ),
  command("agent.revoke", z.object({ agentId: uuid, memberId: uuid }).strict()),
  command(
    "collection.share",
    z
      .object({
        collectionId: uuid,
        memberId: uuid,
        permission: z.enum(["read", "curate"]),
      })
      .strict()
  ),
  command(
    "collection.revoke",
    z.object({ collectionId: uuid, memberId: uuid }).strict()
  ),
  command("contact.ensure", empty),
  command("contact.create", z.object({ displayName: name }).strict()),
  command(
    "contact.block",
    z.object({ contactId: uuid, blocked: z.boolean() }).strict()
  ),
  command(
    "contact.grant",
    z
      .object({
        agentId: uuid,
        contactId: uuid,
        capabilities: z.array(z.literal("invoke")).max(1),
        expiresAt: expiresAt.optional(),
      })
      .strict()
  ),
  command(
    "contact.revoke",
    z.object({ agentId: uuid, contactId: uuid }).strict()
  ),
  command(
    "support.approve",
    z
      .object({
        staffId: uuid,
        reason: z.string().trim().min(1).max(500),
        scope: supportScope,
        expiresAt,
      })
      .strict()
  ),
  command("support.revoke", z.object({ grantId: uuid }).strict()),
  command(
    "support.read",
    z
      .object({
        grantId: uuid,
        resourceType: z.enum(["agent", "collection"]),
        resourceId: uuid,
      })
      .strict()
  ),
  command(
    "member.update",
    z
      .object({
        memberId: uuid,
        role: z.enum(["owner", "admin", "member", "viewer"]),
        status: z.enum(["active", "suspended", "removed"]),
        successorMemberId: uuid.optional(),
      })
      .strict()
  ),
  command("invite.revoke", z.object({ invitationId: uuid }).strict()),
])
export type AccessCommand = z.infer<typeof accessCommand>
export const invitationRequest = z
  .object({
    workspaceId: uuid,
    email: z.email().max(320),
    role: z.enum(["admin", "member", "viewer"]),
  })
  .strict()
export const invitationAcceptance = z
  .object({ workspaceId: uuid, token: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
export const accessResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), id: uuid.nullable(), data: z.unknown() }),
  z.object({ ok: z.literal(false) }),
])
