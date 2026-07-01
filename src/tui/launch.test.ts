import { describe, expect, test } from "bun:test"
import { shouldLaunchInteractive, type InteractiveLaunchContext } from "./launch.ts"

const base: InteractiveLaunchContext = {
  noArgs: true,
  stdoutIsTty: true,
  stdinIsTty: true,
  ci: false,
  term: "xterm-256color",
}

describe("shouldLaunchInteractive", () => {
  test("launches for a bare invocation in a real terminal", () => {
    expect(shouldLaunchInteractive(base)).toBe(true)
  })

  test("never launches when arguments were passed (incl. lone global flags)", () => {
    // `secapi --profile foo` consumes the flag and leaves args empty, but noArgs
    // is computed from the RAW argv, so it must stay false here.
    expect(shouldLaunchInteractive({ ...base, noArgs: false })).toBe(false)
  })

  test("never launches when stdout is not a TTY (piped/redirected)", () => {
    expect(shouldLaunchInteractive({ ...base, stdoutIsTty: false })).toBe(false)
  })

  test("never launches when stdin is not a TTY", () => {
    expect(shouldLaunchInteractive({ ...base, stdinIsTty: false })).toBe(false)
  })

  test("never launches under CI", () => {
    expect(shouldLaunchInteractive({ ...base, ci: true })).toBe(false)
  })

  test("never launches on a dumb terminal", () => {
    expect(shouldLaunchInteractive({ ...base, term: "dumb" })).toBe(false)
  })

  test("launches when TERM is undefined but streams are TTYs", () => {
    expect(shouldLaunchInteractive({ ...base, term: undefined })).toBe(true)
  })
})
