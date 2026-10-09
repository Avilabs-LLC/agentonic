import { z } from "zod"
import { displayNameSchema, uuid } from "./identity"

const name = z.string().trim().min(1).max(120)
const slug = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
const description = z.string().trim().max(2000).optional()
export const customerAgentCreation = z
  .object({ name, slug, description })
  .strict()
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
  .object({
    workspaceId: uuid,
    token: z.string().regex(/^[a-f0-9]{64}$/),
    displayName: displayNameSchema.shape.displayName,
  })
  .strict()
export const accessResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), id: uuid.nullable(), data: z.unknown() }),
  z.object({ ok: z.literal(false) }),
])
// Members and invitations, as the Miembros page shows them (architecture §54).
export const memberRoleLabels: Record<string, string> = {
  owner: "Propietario",
  admin: "Administrador",
  member: "Miembro",
  viewer: "Lector",
}
export const memberInvitationInput = z
  .object({
    workspaceId: uuid,
    email: z.email("Introduce un correo válido.").max(320),
    role: z.enum(["admin", "member", "viewer"]),
  })
  .strict()
export type MemberInvitationInput = z.infer<typeof memberInvitationInput>
export const workspaceMember = z.object({
  id: uuid,
  displayName: z.string(),
  // Null until the person signs in after migration 57.
  email: z.string().nullable().default(null),
  role: z.string(),
  status: z.string(),
})
export type WorkspaceMember = z.infer<typeof workspaceMember>
export const workspaceInvitation = z.object({
  id: uuid,
  email: z.string(),
  role: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
})
export type WorkspaceInvitation = z.infer<typeof workspaceInvitation>
/** An invitation's state, derived from its dates. */
export function invitationState(
  invitation: WorkspaceInvitation,
  now = new Date()
): "pending" | "accepted" | "revoked" | "expired" {
  if (invitation.acceptedAt) return "accepted"
  if (invitation.revokedAt) return "revoked"
  return Date.parse(invitation.expiresAt) <= now.getTime()
    ? "expired"
    : "pending"
}
export const workspaceMembers = z.array(workspaceMember)
export const workspaceInvitations = z.array(workspaceInvitation)
export const invitationRevocation = z
  .object({ workspaceId: uuid, invitationId: uuid })
  .strict()

// Agentonic's team, as Admin's Equipo page shows it (architecture §63). Only
// these three roles are offered; "billing" exists in the table but grants nothing.
export const staffRoles = ["administrator", "operator", "support"] as const
export type StaffRole = (typeof staffRoles)[number]
/** What each offered role may do, for the invitation and role-change dialogs. */
export const staffRoleDescriptions: Record<StaffRole, string> = {
  administrator:
    "Lo mismo que Operación, y además invita al equipo, cambia roles y desactiva personas.",
  operator:
    "Aprueba versiones y activa despliegues de pruebas, además de consultar todas las pantallas.",
  support:
    "Consulta las pantallas de Administración. No aprueba versiones ni activa despliegues.",
}
export const staffInvitationInput = z
  .object({
    email: z.email("Introduce un correo válido.").max(320),
    role: z.enum(staffRoles),
  })
  .strict()
export type StaffInvitationInput = z.infer<typeof staffInvitationInput>
export const staffUpdateInput = z.union([
  z.object({ staffId: uuid, role: z.enum(staffRoles) }).strict(),
  z.object({ staffId: uuid, active: z.boolean() }).strict(),
])
export type StaffUpdateInput = z.infer<typeof staffUpdateInput>
export const staffInvitationAcceptance = z
  .object({
    token: z.string().regex(/^[a-f0-9]{64}$/),
    displayName: displayNameSchema.shape.displayName,
  })
  .strict()
export const staffMember = z.object({
  id: uuid,
  name: z.string(),
  // Administrators only; null for everyone else, and until the person signs in.
  email: z.string().nullable(),
  role: z.string(),
  status: z.enum(["active", "disabled"]),
  since: z.string(),
})
export type StaffMember = z.infer<typeof staffMember>
export const staffTeam = z.object({
  viewer: z.object({ staffId: uuid, role: z.string() }),
  staff: z.array(staffMember),
  // Administrators only.
  invitations: z.array(workspaceInvitation).nullable(),
})
export type StaffTeam = z.infer<typeof staffTeam>
