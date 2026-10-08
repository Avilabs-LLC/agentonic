"use server"
import { passwordSignIn, signOut } from "@agentonic/server/actions"
import type {
  DisplayNameInput,
  EmailOnlyInput,
  NewPasswordInput,
  SignInInput,
} from "@agentonic/contracts/identity"
import {
  acceptInvitation,
  changePassword,
  requestPasswordReset,
  updateDisplayName,
} from "@agentonic/server/account"
export async function login(input: SignInInput) {
  return passwordSignIn("customer", input)
}
export async function logout() {
  return signOut("customer")
}
export async function requestReset(input: EmailOnlyInput) {
  return requestPasswordReset("customer", input)
}
export async function savePassword(input: NewPasswordInput) {
  return changePassword("customer", input)
}
export async function acceptWorkspace(
  workspaceId: string,
  token: string,
  input: DisplayNameInput
) {
  return acceptInvitation({
    workspaceId,
    token,
    displayName: input.displayName,
  })
}
export async function saveDisplayName(input: DisplayNameInput) {
  return updateDisplayName("customer", input)
}
