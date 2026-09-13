"use server"
import { passwordSignIn, signOut } from "@agentonic/server/actions"
import type { SignInInput } from "@agentonic/contracts/identity"
export async function login(input: SignInInput) {
  return passwordSignIn("admin", input)
}
export async function logout() {
  return signOut("admin")
}
