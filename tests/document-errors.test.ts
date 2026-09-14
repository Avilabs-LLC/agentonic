import { expect, it } from "vitest"
import { documentUploadFailure } from "../packages/contracts/src/document-errors"
it("identifies header rejection even without a JSON response or server reference", () => {
  expect(documentUploadFailure(undefined, 431, null)).toContain(
    "datos de sesión"
  )
  expect(documentUploadFailure(undefined, 431, null)).toContain(
    "HTTP 431 · Sin referencia del servidor"
  )
})
it("never displays unknown provider details or an arbitrary response header", () => {
  const message = documentUploadFailure(
    "private provider details",
    503,
    "private response header"
  )
  expect(message).not.toContain("private")
  expect(message).toContain("HTTP 503")
})
