// Pure gating predicate for the interactive TUI.
//
// The interactive REPL must engage ONLY for a bare `secapi` typed in a real
// terminal. Every other shape — piped, redirected, CI, dumb-terminal, --json,
// or ANY argument (including a lone global flag like `--profile`/`--base-url`)
// — must keep the exact one-shot behavior, so agents and the
// test/bench/smoke gates (all non-TTY) are unaffected.
//
// Kept pure and separate from index.ts so the gating matrix is unit-testable
// without spawning a process or a PTY.

export interface InteractiveLaunchContext {
  /**
   * True only for a truly bare invocation — computed from the RAW argv before
   * any global-flag consumption. `secapi --profile foo` (no command) is NOT
   * bare: it must print root help, exactly as before the TUI existed.
   */
  noArgs: boolean
  stdoutIsTty: boolean
  stdinIsTty: boolean
  /** process.env.CI is set to any truthy value. */
  ci: boolean
  /** process.env.TERM */
  term: string | undefined
}

export function shouldLaunchInteractive(ctx: InteractiveLaunchContext): boolean {
  return ctx.noArgs && ctx.stdoutIsTty && ctx.stdinIsTty && !ctx.ci && ctx.term !== "dumb"
}
