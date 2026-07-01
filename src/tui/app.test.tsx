import { describe, expect, test } from "bun:test"
import { render } from "ink"
import { PassThrough } from "node:stream"
import React from "react"
import { askModeResponse, childStderrKind, commandPlan, entriesToLogItems, Repl, shouldTreatAsCancelled } from "./app.tsx"

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
