"use server"
import { inviteMember, revokeInvitation } from "@agentonic/server/account"
import type { MemberInvitationInput } from "@agentonic/contracts/access"
export async function inviteToWorkspace(input: MemberInvitationInput) {
  return inviteMember(input)
}
export async function revokeWorkspaceInvitation(
  workspaceId: string,
  invitationId: string
) {
  return revokeInvitation({ workspaceId, invitationId })
}
