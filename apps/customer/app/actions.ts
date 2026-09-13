"use server"
import { passwordSignIn, signOut } from "@agentonic/server/actions"
import type { SignInInput } from "@agentonic/contracts/identity"
export async function login(input: SignInInput) {
  return passwordSignIn("customer", input)
}
export async function logout() {
  return signOut("customer")
}
