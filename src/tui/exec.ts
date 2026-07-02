// Command execution for the REPL.
//
// We execute a typed command by re-spawning the CLI itself with the same argv,
// so the REPL reuses the ENTIRE one-shot dispatch (every command, flag, auth
// path) with zero duplication. The child is spawned with SECAPI_TUI=1 +
// FORCE_COLOR so it emits themed rich cards; the REPL captures that and prints
// it into the Ink scrollback. (SECAPI_TUI is an internal hatch honored only to
// let the REPL force rich output for a captured, non-TTY child.)
import { spawn as nodeSpawn } from "node:child_process"

const ABORT_KILL_ESCALATION_MS = 1_000
const STDIN_CREDENTIAL_FLAGS = new Set(["--api-key-stdin", "--bearer-token-stdin"])
const FORWARDED_STRING_GLOBALS = new Set(["--profile", "--base-url", "--theme", "--accent"])

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

export type Spawner = (cmd: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<ExecResult>

/** Tokenize a command line, honoring simple single/double quotes. */
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "")
  }
  return tokens
}

export const defaultSpawner: Spawner = (cmd, args, env, signal) =>
  new Promise((resolve) => {
    const child = nodeSpawn(cmd, args, { env })
    let settled = false
    let onAbort: (() => void) | undefined
    let abortKillTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: ExecResult) => {
      if (settled) return
      settled = true
      if (onAbort) signal?.removeEventListener("abort", onAbort)
      if (abortKillTimer) clearTimeout(abortKillTimer)
      resolve(result)
    }
    let stdout = ""
    let stderr = ""
    onAbort = () => {
      child.kill("SIGTERM")
      abortKillTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL")
      }, ABORT_KILL_ESCALATION_MS)
    }
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("close", (code) => finish({ stdout, stderr, code: signal?.aborted ? 130 : code ?? 0 }))
    child.on("error", (error) => finish({ stdout, stderr: `${stderr}${String(error)}`, code: 1 }))
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })

function hasFlagToken(tokens: string[], flag: string): boolean {
  return tokens.some((token) => token === flag || token.startsWith(`${flag}=`))
}

function withoutOverriddenForwardedArgs(forwardedArgs: string[], tokens: string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < forwardedArgs.length; index += 1) {
    const arg = forwardedArgs[index]
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg
    if (FORWARDED_STRING_GLOBALS.has(flag) && hasFlagToken(tokens, flag)) {
      if (arg === flag && index + 1 < forwardedArgs.length) index += 1
      continue
    }
    result.push(arg)
  }
  return result
}

export interface RunCommandOptions {
  /** process.execPath (node/bun). */
  selfExec: string
  /** process.argv[1] (the CLI entry — dist/index.js or src/index.ts). */
  selfEntry: string
  /** Force rich card output in the spawned child. */
  rich: boolean
  /** Global flags from the parent REPL invocation that child commands must inherit. */
  forwardedArgs?: string[]
  spawner?: Spawner
  baseEnv?: NodeJS.ProcessEnv
  /** Abort to kill an in-flight child (REPL ctrl+c during a running command). */
  signal?: AbortSignal
}

export interface RunShellCommandOptions {
  spawner?: Spawner
  baseEnv?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** Injectable for tests; defaults to process.platform. */
  platform?: NodeJS.Platform
}

/** Picks the shell + invocation args for `!<command>` on the current platform. */
export function chooseShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { shell: string; args: (command: string) => string[] } {
  if (platform === "win32") {
    const shell = env.ComSpec?.trim() || env.COMSPEC?.trim() || "cmd.exe"
    return { shell, args: (command) => ["/d", "/s", "/c", command] }
  }
  const shell = env.SHELL?.trim() || "/bin/sh"
  return { shell, args: (command) => ["-c", command] }
}

/**
 * `!<command>` bash-escape — runs `command` through the user's own shell
 * ($SHELL on POSIX, ComSpec/cmd.exe on Windows). This is the same trust
 * boundary as the user typing the command in their real terminal: no extra
 * sanitization is applied (it IS shell syntax by definition), but it never
 * touches SECAPI_* credentials beyond what the ambient environment already has.
 */
export async function runShellCommand(command: string, opts: RunShellCommandOptions = {}): Promise<ExecResult> {
  const spawner = opts.spawner ?? defaultSpawner
  const env = opts.baseEnv ?? process.env
  const { shell, args } = chooseShell(env, opts.platform ?? process.platform)
  return spawner(shell, args(command), env, opts.signal)
}

export async function runCommand(input: string, opts: RunCommandOptions): Promise<ExecResult> {
  const tokens = tokenizeCommand(input)
  if (tokens.length === 0) return { stdout: "", stderr: "", code: 0 }
  if (tokens.some((token) => STDIN_CREDENTIAL_FLAGS.has(token))) {
    return {
      stdout: "",
      stderr: "stdin credential flags are unavailable inside the interactive REPL. Set SECAPI_API_KEY in the environment before launching the REPL, or run this command outside the REPL.\n",
      code: 1,
    }
  }
  const spawner = opts.spawner ?? defaultSpawner
  const env: NodeJS.ProcessEnv = { ...(opts.baseEnv ?? process.env) }
  // In the REPL we force rich card output AND request a cost summary on stderr
  // (parsed into the session ledger); --request-summary keeps the result on
  // stdout, so the captured card is unaffected.
  const extra = opts.rich ? ["--request-summary=true"] : []
  if (opts.rich) {
    env.SECAPI_TUI = "1"
    env.FORCE_COLOR = "3"
    delete env.NO_COLOR
  }
  return spawner(opts.selfExec, [opts.selfEntry, ...withoutOverriddenForwardedArgs(opts.forwardedArgs ?? [], tokens), ...tokens, ...extra], env, opts.signal)
}
