import { describe, expect, test } from "bun:test"
import { render } from "ink"
import { PassThrough } from "node:stream"
import React from "react"
import { askModeResponse, childStderrKind, commandPlan, entriesToLogItems, isQuotableInPlanMode, Repl, shouldTreatAsCancelled } from "./app.tsx"

// Injected-stream render (PTY-free, deterministic) proves the REPL mounts and
// renders its banner + prompt without a real terminal.
describe("Repl render", () => {
  test("renders the banner, tagline, and a prompt", async () => {
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream
    ;(stdout as unknown as { columns: number }).columns = 90
    ;(stdout as unknown as { rows: number }).rows = 24
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream
    ;(stdin as unknown as { isTTY: boolean }).isTTY = true
    ;(stdin as unknown as { setRawMode: () => void }).setRawMode = () => {}
    ;(stdin as unknown as { ref: () => void }).ref = () => {}
    ;(stdin as unknown as { unref: () => void }).unref = () => {}

    let out = ""
    stdout.on("data", (chunk: Buffer | string) => {
      out += chunk.toString()
    })

    const app = render(
      <Repl
        version="9.9.9"
        commandCount={142}
        selfExec="node"
        selfEntry="x"
        paletteEntries={[]}
        sessionId="sess_test"
        forwardedArgs={["--profile", "staging"]}
      />,
      { stdout, stdin, patchConsole: false },
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    app.unmount()

    const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    expect(clean).toContain("SEC API")
    expect(clean).toContain("trading desk")
    expect(clean).toContain("142 commands")
  })
})

describe("REPL mode helpers", () => {
  test("plan mode previews likely execution without running the command", () => {
    const plan = commandPlan("filings latest --ticker AAPL")

    expect(plan).toContain("Plan: secapi filings latest --ticker AAPL")
    expect(plan).toContain("API request likely")
    expect(plan).toContain("No command was run")
  })

  test("plan mode calls out machine-output flags and mutation risk", () => {
    const plan = commandPlan("webhooks create --destination-url https://example.com --json")

    expect(plan).toContain("machine-readable")
    expect(plan).toContain("may create")
  })

  test("isQuotableInPlanMode is true only for the intelligence group (the only ai_queries-metered commands)", () => {
    expect(isQuotableInPlanMode(["intelligence", "company", "--ticker", "AAPL"])).toBe(true)
    expect(isQuotableInPlanMode(["filings", "latest", "--ticker", "AAPL"])).toBe(false)
    expect(isQuotableInPlanMode([])).toBe(false)
  })

  test("plan mode shows a real dollar estimate when a quote is supplied", () => {
    const plan = commandPlan("intelligence company --ticker AAPL", { amountCents: 250 })
    expect(plan).toContain("Estimated cost: $2.5000")
    expect(plan).not.toContain("unavailable")
  })

  test("plan mode surfaces the budget gate message when the quote includes one", () => {
    const plan = commandPlan("intelligence company --ticker AAPL", {
      amountCents: 250,
      budgetGate: { code: "billing_budget_hard_cap_exceeded", message: "This request would exceed the configured billing hard cap." },
    })
    expect(plan).toContain("Budget: This request would exceed the configured billing hard cap.")
  })

  test("plan mode falls back to an 'unavailable' note for a quotable command when no quote was fetched", () => {
    const plan = commandPlan("intelligence company --ticker AAPL", null)
    expect(plan).toContain("Estimated cost: unavailable")
  })

  test("plan mode omits any cost line entirely for non-quotable commands", () => {
    const plan = commandPlan("filings latest --ticker AAPL", null)
    expect(plan).not.toContain("Estimated cost")
  })

  test("ask mode blocks execution in this release", () => {
    const response = askModeResponse("billing checkout --plan personal")

    expect(response).toContain("was not executed")
    expect(response).toContain("blocks API calls, mutations, and billable work")
  })

  test("cancel handling does not hide successful output from a completed command", () => {
    expect(shouldTreatAsCancelled({ stdout: "done\n", stderr: "", code: 0 }, true)).toBe(false)
    expect(shouldTreatAsCancelled({ stdout: "", stderr: "", code: 130 }, true)).toBe(true)
  })

  test("successful child stderr is displayed as informational output", () => {
    expect(childStderrKind({ stdout: "ok\n", stderr: "[secapi settings] warning\n", code: 0 })).toBe("info")
    expect(childStderrKind({ stdout: "", stderr: "No API key\n", code: 1 })).toBe("error")
  })

  test("loaded session entries replace scrollback without mutating the source entries", () => {
    const entries = [
      { ts: "2026-06-30T00:00:00.000Z", kind: "prompt" as const, text: "◈ filings latest --ticker AAPL" },
      { ts: "2026-06-30T00:00:01.000Z", kind: "output" as const, text: "AAPL · 10-K" },
    ]
    const items = entriesToLogItems(entries)
    expect(items.map((item) => item.text)).toEqual(entries.map((entry) => entry.text))
    expect(entries).toHaveLength(2)
  })
})
