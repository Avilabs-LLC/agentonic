"use server"
import { passwordSignIn, signOut } from "@agentonic/server/actions"
import type {
  EmailOnlyInput,
  MfaCodeInput,
  NewPasswordInput,
  SignInInput,
} from "@agentonic/contracts/identity"
import {
  changePassword,
  confirmAuthenticator,
  disableAuthenticator,
  requestPasswordReset,
  startAuthenticator,
  verifyAuthenticator,
} from "@agentonic/server/account"
export async function login(input: SignInInput) {
  return passwordSignIn("admin", input)
}
export async function logout() {
  return signOut("admin")
}
export async function requestReset(input: EmailOnlyInput) {
  return requestPasswordReset("admin", input)
}
export async function savePassword(input: NewPasswordInput) {
  return changePassword("admin", input)
}
export async function verifyMfa(input: MfaCodeInput) {
  return verifyAuthenticator(input)
}
export async function startMfa() {
  return startAuthenticator()
}
export async function confirmMfa(input: { factorId: string; code: string }) {
  return confirmAuthenticator(input)
}
export async function disableMfa() {
  return disableAuthenticator()
}
