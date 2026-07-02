// A masked (asterisk-echoing) TTY prompt for pasting a credential during
// `secapi login` human/paste mode. Deliberately NOT Ink and not readline's
// internal write hooks — a small self-contained raw-mode byte reader, so
// one-shot `secapi login` never pays Ink's import cost (bench-verified) and
// this stays testable with the same injected-stream pattern the REPL uses.

export interface PromptStreams {
  input: NodeJS.ReadStream
  output: NodeJS.WriteStream
}

const CTRL_C = "\u0003"
const BACKSPACE_DEL = "\u007f"
const BACKSPACE_BS = "\b"

/**
 * Prompts `question`, echoing `*` per keystroke. Enter submits the trimmed
 * value; ctrl+c cancels to `""`. Never touches SECAPI_* env vars — the caller
 * decides what (if anything) to do with the returned string; it is never
 * itself persisted to a profile (profiles store env-var NAMES only).
 *
 * Defaults to writing the prompt/mask characters on STDERR, not stdout — a
 * command's stdout must stay reserved for its JSON result (the same rule
 * every status/progress line in this CLI already follows).
 */
export function maskedPrompt(question: string, streams?: Partial<PromptStreams>): Promise<string> {
  const input = (streams?.input ?? process.stdin) as NodeJS.ReadStream
  const output = (streams?.output ?? process.stderr) as NodeJS.WriteStream
  return new Promise((resolve) => {
    output.write(question)
    let value = ""
    const canRaw = typeof input.setRawMode === "function"
    if (canRaw) input.setRawMode(true)
    input.resume()
    input.setEncoding("utf8")

    const cleanup = () => {
      input.off("data", onData)
      if (canRaw) input.setRawMode(false)
      input.pause()
    }

    function onData(chunk: string) {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup()
          output.write("\n")
          resolve(value.trim())
          return
        }
        if (ch === CTRL_C) {
          cleanup()
          output.write("\n")
          resolve("")
          return
        }
        if (ch === BACKSPACE_DEL || ch === BACKSPACE_BS) {
          if (value.length > 0) {
            value = value.slice(0, -1)
            output.write("\b \b")
          }
          continue
        }
        value += ch
        output.write("*")
      }
    }

    input.on("data", onData)
  })
}
