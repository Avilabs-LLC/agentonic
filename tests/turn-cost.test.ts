import { describe, expect, it } from "vitest"

// What a turn cost, under its answer in Chats and Probar agente (architecture
// §82), rendered on the server with synthetic amounts.
const load = (path: string) =>
  import(/* @vite-ignore */ path) as Promise<Record<string, unknown>>
type Component = (props: Record<string, unknown>) => unknown
const react = await load("../packages/ui/node_modules/react/index.js")
const server = await load(
  "../packages/ui/node_modules/react-dom/server.node.js"
)
const { TurnCost, runningSpend } = (await load(
  "../packages/ui/src/components/turn-cost"
)) as {
  TurnCost: Component
  runningSpend: (turns: { spentMicrousd?: number }[]) => number[]
}
const text = (props: Record<string, unknown>) =>
  (server.renderToStaticMarkup as (e: unknown) => string)(
    (react.createElement as (c: unknown, p: unknown) => unknown)(
      TurnCost,
      props
    )
  ).replace(/<[^>]+>/g, "")

describe("Chats › what a turn cost", () => {
  it("shows the turn alone on a first turn, with the model when given", () => {
    expect(
      text({
        spentMicrousd: 31234,
        totalMicrousd: 31234,
        model: { model: "gpt-6-astra", reasoning: "low" },
      })
    ).toBe("US$0,03 este turno · GPT-6 Astra · Bajo")
  })

  it("adds the conversation so far once earlier turns cost something", () => {
    expect(text({ spentMicrousd: 371000, totalMicrousd: 1377000 })).toBe(
      "US$0,37 este turno · US$1,38 en esta conversación"
    )
  })

  it("says what is still held as unknown, and keeps sub-cent turns honest", () => {
    expect(
      text({ spentMicrousd: 1200, heldMicrousd: 900000, totalMicrousd: 1200 })
    ).toBe("menos de US$0,01 este turno, más hasta US$0,90 sin confirmar")
  })

  it("shows nothing for a turn without a ledger figure", () => {
    expect(text({ totalMicrousd: 0 })).toBe("")
  })

  it("adds up the conversation turn by turn", () => {
    expect(
      runningSpend([{ spentMicrousd: 1000 }, {}, { spentMicrousd: 2500 }])
    ).toEqual([1000, 1000, 3500])
  })
})
