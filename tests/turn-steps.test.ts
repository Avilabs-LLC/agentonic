import { expect, it } from "vitest"
import {
  stepText,
  turnStepTool,
  turnSteps,
  TURN_STEP_TARGET,
  type TurnStep,
} from "../packages/contracts/src/turn-steps"
import { describeStep } from "../packages/ui/src/lib/turn-steps"

const step = (over: Partial<TurnStep>): TurnStep => ({
  tool: "gmail.search",
  target: null,
  count: null,
  status: "done",
  ...over,
})

it("bounds a step's text to one line of 200 characters (§74)", () => {
  expect(stepText("  Re:\n  Cotización\tQ4 ")).toBe("Re: Cotización Q4")
  expect(stepText("x".repeat(500))).toHaveLength(TURN_STEP_TARGET)
  expect(stepText("x".repeat(500))!.endsWith("…")).toBe(true)
  expect(stepText("   ")).toBeNull()
  expect(stepText(3)).toBeNull()
  expect(turnSteps.safeParse([step({ target: "x".repeat(201) })]).success).toBe(
    false
  )
})

it("says what every step did in Spanish, whatever its state (§74)", () => {
  for (const tool of turnStepTool.options)
    for (const status of ["running", "done", "proposed", "failed"] as const)
      for (const target of [null, "Cotización Q4"])
        expect(
          describeStep(step({ tool, status, target, count: 2 })).length
        ).toBeGreaterThan(5)
  expect(
    describeStep(
      step({ target: "from:ana newer_than:7d", count: 8, status: "done" })
    )
  ).toBe("Buscó en Gmail «from:ana newer_than:7d» · 8 correos")
  expect(describeStep(step({ count: 0 }))).toBe(
    "Buscó en Gmail · sin resultados"
  )
  expect(describeStep(step({ count: 1 }))).toBe("Buscó en Gmail · 1 correo")
  expect(
    describeStep(
      step({ tool: "gmail.threads.read", target: "Cotización Q4", count: 5 })
    )
  ).toBe("Leyó la conversación «Cotización Q4» · 5 mensajes")
  expect(
    describeStep(
      step({
        tool: "gmail.drafts.create",
        target: "Re: Cotización Q4",
        status: "proposed",
      })
    )
  ).toBe("Propuso el borrador «Re: Cotización Q4»")
  expect(describeStep(step({ tool: "web.read", target: "example.com" }))).toBe(
    "Leyó example.com"
  )
  expect(describeStep(step({ tool: "gmail.read", status: "failed" }))).toBe(
    "No se pudo leer un correo"
  )
  // A step still open when its turn ended is shown as unfinished.
  expect(
    describeStep(step({ tool: "gmail.read", status: "running" }), false)
  ).toBe("Leyendo un correo (sin terminar)")
})
