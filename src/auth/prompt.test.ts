import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { maskedPrompt } from "./prompt.ts"

function fakeStreams() {
  const input = new PassThrough() as unknown as NodeJS.ReadStream
  ;(input as unknown as { setRawMode: (v: boolean) => void }).setRawMode = () => {}
  const output = new PassThrough() as unknown as NodeJS.WriteStream
  let written = ""
  ;(output as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    written += chunk
    return true
  }
  return { input, output, getWritten: () => written }
}

describe("maskedPrompt", () => {
  test("echoes * per keystroke and resolves the trimmed value on Enter", async () => {
    const { input, output, getWritten } = fakeStreams()
    const promise = maskedPrompt("API key: ", { input, output })
    ;(input as unknown as PassThrough).write("secapi_live_abc123")
    ;(input as unknown as PassThrough).write("\r")
    const value = await promise
    expect(value).toBe("secapi_live_abc123")
    expect(getWritten()).toContain("API key: ")
    expect(getWritten()).toContain("*".repeat("secapi_live_abc123".length))
    expect(getWritten()).not.toContain("secapi_live_abc123") // never echoed in the clear
  })

  test("ctrl+c cancels to an empty string", async () => {
    const { input, output } = fakeStreams()
    const promise = maskedPrompt("API key: ", { input, output })
    ;(input as unknown as PassThrough).write("partial")
    ;(input as unknown as PassThrough).write("\u0003") // ctrl+c
    expect(await promise).toBe("")
  })

  test("backspace removes the last character", async () => {
    const { input, output } = fakeStreams()
    const promise = maskedPrompt("API key: ", { input, output })
    ;(input as unknown as PassThrough).write("abcX")
    ;(input as unknown as PassThrough).write("\u007f") // DEL
    ;(input as unknown as PassThrough).write("\n")
    expect(await promise).toBe("abc")
  })

  test("trims surrounding whitespace from the submitted value", async () => {
    const { input, output } = fakeStreams()
    const promise = maskedPrompt("API key: ", { input, output })
    ;(input as unknown as PassThrough).write("  spaced-key  ")
    ;(input as unknown as PassThrough).write("\n")
    expect(await promise).toBe("spaced-key")
  })
})
