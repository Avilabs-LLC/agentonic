"use server"
import {
  inviteStaff,
  revokeStaffInvitation,
  updateStaff,
} from "@agentonic/server/account"
import type {
  StaffInvitationInput,
  StaffUpdateInput,
} from "@agentonic/contracts/access"
export async function inviteToTeam(input: StaffInvitationInput) {
  return inviteStaff(input)
}
export async function revokeTeamInvitation(invitationId: string) {
  return revokeStaffInvitation(invitationId)
}
export async function updateTeamMember(input: StaffUpdateInput) {
  return updateStaff(input)
}
