// Interactive REPL (Ink). Loaded ONLY via a dynamic import from the no-arg-TTY
// branch in index.ts, so one-shot / piped / CI invocations never import React
// or Ink and pay zero startup cost. Everything here renders only inside a TTY.
//
// "The trading desk in your terminal": a banner, a scrollback log, a prompt with
// run/plan/ask modes (shift+tab) and a live status line. Typed commands are
// executed by re-spawning the CLI itself (exec.ts), so the REPL reuses the full
// one-shot dispatch with rich card output.
import { Box, render, Static, Text, useApp, useInput, useStdout } from "ink"
import { homedir } from "node:os"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  createSessionId,
  exportSessionAs,
  latestSessionId,
  listSessions,
  loadSession,
  normalizeExportFormat,
  redactSessionEntry,
  saveSession,
  type SessionEntry,
  type SessionTranscript,
} from "../session/session.ts"
import { createCostLedger, extractRequestSummary, formatCostFooter, stripRequestSummary } from "../cost/cost.ts"
import { expandSkill, findSkillShortcut, skillIsMetered, SKILL_SHORTCUTS } from "../skills/catalog.ts"
import { runCommand, tokenizeCommand, type ExecResult } from "./exec.ts"
import { modeIndicator, modeMeta, nextMode, type ModeKey } from "./modes.ts"
import { filterPalette, type PaletteEntry } from "./palette.ts"
import { parseSlash, SLASH_COMMANDS } from "./slash.ts"

const BRAND_MARK = "◈"
const ACCENT = "cyan"
const SPINNER_FRAMES = ["⬒", "⬔", "⬓", "⬕"]

interface LogItem {
  id: number
  kind: "prompt" | "output" | "info" | "error"
  text: string
}

export interface StartOptions {
  version: string
  commandCount: number
  selfExec: string
  selfEntry: string
  /** Prebuilt palette index (slash + all CLI commands) from the registry. */
  paletteEntries: PaletteEntry[]
  /** Stable id for this session's transcript. */
  sessionId: string
  /** Global flags from the parent REPL invocation forwarded into child commands. */
  forwardedArgs?: string[]
}

const MUTATING_TERMS = new Set(["checkout", "create", "delete", "install", "init", "post", "put", "setup", "update"])

export function commandPlan(input: string): string {
  const tokens = tokenizeCommand(input)
  if (tokens.length === 0) return "Plan: no command entered."
  const machineOutput = tokens.includes("--json") || tokens.some((token) => token.startsWith("--json=")) || tokens.includes("--output") || tokens.some((token) => token.startsWith("--output="))
  const localOnly = ["agent-context", "completion", "config", "examples", "help", "init"].includes(tokens[0])
  const mutating = tokens.some((token) => MUTATING_TERMS.has(token))
  const lines = [
    `Plan: secapi ${tokens.join(" ")}`,
    `Execution: ${localOnly ? "local-first" : "API request likely"}`,
    `Output: ${machineOutput ? "machine-readable/file output requested" : "interactive rich output if supported"}`,
    `Risk: ${mutating ? "may create, install, update, or change account state" : "read-only or diagnostic-looking command"}`,
    "No command was run. Switch to Run mode to execute it.",
  ]
  return lines.join("\n")
}

export function askModeResponse(input: string): string {
  const tokens = tokenizeCommand(input)
  if (tokens.length === 0) return "Ask: type a secapi command or use /help for REPL shortcuts."
  if (tokens.includes("--help") || tokens.includes("-h")) {
    return `Ask: switch to Run mode to display help for \`secapi ${tokens.join(" ")}\`.`
  }
  return [
    `Ask: \`secapi ${tokens.join(" ")}\` was not executed.`,
    "Ask mode is advisory only in this release, so it blocks API calls, mutations, and billable work.",
    "Use Plan mode for a command preview or Run mode to execute.",
  ].join("\n")
}

export function shouldTreatAsCancelled(result: ExecResult, aborted: boolean): boolean {
  return aborted && result.code === 130 && result.stdout.trim() === "" && result.stderr.trim() === ""
}

export function childStderrKind(result: ExecResult): LogItem["kind"] {
  return result.code === 0 ? "info" : "error"
}

export function entriesToLogItems(entries: SessionEntry[]): LogItem[] {
  return entries.map((entry, index) => ({ id: index + Math.random(), kind: entry.kind, text: entry.text }))
}

function Banner({ version, commandCount }: { version: string; commandCount: number }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={ACCENT} bold>
          {BRAND_MARK} SEC API
        </Text>
        <Text dimColor> v{version} · {commandCount} commands</Text>
      </Box>
      <Text dimColor>the trading desk in your terminal</Text>
      <Text dimColor>
        Type a command (e.g. <Text color={ACCENT}>filings latest --ticker AAPL</Text>), <Text color={ACCENT}>/help</Text> for
        shortcuts, <Text color={ACCENT}>/quit</Text> to exit.
      </Text>
    </Box>
  )
}

export function Repl(options: StartOptions) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [items, setItems] = useState<LogItem[]>([])
  const [epoch, setEpoch] = useState(0) // bump to clear scrollback (remounts <Static>)
  const [input, setInput] = useState("")
  const [mode, setMode] = useState<ModeKey>("run")
  const [running, setRunning] = useState(false)
  const [spinner, setSpinner] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [histIndex, setHistIndex] = useState<number | null>(null)
  const [sessionCalls, setSessionCalls] = useState(0)
  const [ctrlCArmed, setCtrlCArmed] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteIndex, setPaletteIndex] = useState(0)
  const sessionEntries = useRef<SessionEntry[]>([])
  const activeSessionId = useRef(options.sessionId)
  const startedAt = useRef(new Date().toISOString())
  const abortRef = useRef<AbortController | null>(null)
  const ledger = useRef(createCostLedger())
  const [meterText, setMeterText] = useState("")

  const palette = useMemo(
    () => (paletteOpen ? filterPalette(options.paletteEntries, input) : []),
    [paletteOpen, input, options.paletteEntries],
  )

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setSpinner((s) => (s + 1) % SPINNER_FRAMES.length), 120)
    return () => clearInterval(timer)
  }, [running])

  const replaceSessionEntries = useCallback((entries: SessionEntry[]) => {
    const redacted = entries.map(redactSessionEntry)
    sessionEntries.current = redacted
    setItems(entriesToLogItems(redacted))
    setEpoch((e) => e + 1)
  }, [])

  const push = useCallback((kind: LogItem["kind"], text: string) => {
    const entry = redactSessionEntry({ ts: new Date().toISOString(), kind, text })
    sessionEntries.current.push(entry)
    setItems((prev) => [...prev, { id: prev.length + Math.random(), kind: entry.kind, text: entry.text }])
  }, [])

  const transcript = useCallback(
    (): SessionTranscript => ({
      object: "secapi_cli_session",
      id: activeSessionId.current,
      startedAt: startedAt.current,
      entries: sessionEntries.current,
    }),
    [],
  )

  const saveCurrentSession = useCallback(() => {
    if (sessionEntries.current.length === 0) return null
    return saveSession(process.env, homedir(), transcript())
  }, [transcript])

  const clearSession = useCallback(() => {
    try {
      saveCurrentSession()
    } catch {
      // Clearing the screen must remain responsive even if persistence fails.
    }
    activeSessionId.current = createSessionId()
    startedAt.current = new Date().toISOString()
    sessionEntries.current = []
    setItems([])
    setSessionCalls(0)
    setEpoch((e) => e + 1)
  }, [saveCurrentSession])

  const exitRepl = useCallback(() => {
    try {
      saveCurrentSession()
    } catch {
      // Persisting the transcript is best-effort; never block exit.
    }
    exit()
  }, [exit, saveCurrentSession])

  const handleSlash = useCallback(
    (line: string): boolean => {
      const parsed = parseSlash(line)
      if (!parsed) return false
      switch (parsed.name) {
        case "quit":
        case "exit":
          exitRepl()
          return true
        case "clear":
          if (running) {
            push("info", "Command is still running. Press ctrl+c to cancel before clearing.")
            return true
          }
          clearSession()
          return true
        case "export": {
          try {
            const format = normalizeExportFormat(parsed.args[0])
            const current = transcript()
            if (current.entries.length === 0) {
              push("info", "No session entries to save.")
            } else {
              const path = exportSessionAs(process.env, homedir(), current, format)
              push("info", `Saved session (${format}) to ${path}`)
            }
          } catch (error) {
            push("error", `Could not save session: ${String(error)}`)
          }
          return true
        }
        case "resume": {
          const id = latestSessionId(process.env, homedir())
          if (!id) {
            push("info", "No saved session to resume.")
            return true
          }
          if (id === activeSessionId.current) {
            push("info", "Current session is already active.")
            return true
          }
          const prior = loadSession(process.env, homedir(), id)
          if (!prior) {
            push("info", "No saved session to resume.")
            return true
          }
          try {
            saveCurrentSession()
          } catch {
            // Resume should still work if the best-effort current-session save fails.
          }
          activeSessionId.current = prior.id
          startedAt.current = prior.startedAt
          replaceSessionEntries(prior.entries)
          push("info", `Resumed session ${prior.id} (${prior.entries.length} entries).`)
          return true
        }
        case "sessions": {
          const all = listSessions(process.env, homedir())
          push(
            "info",
            all.length === 0
              ? "No saved sessions yet."
              : ["Saved sessions:", ...all.slice(0, 10).map((s) => `  ${s.id} · ${s.startedAt} · ${s.entryCount} entries`)].join("\n"),
          )
          return true
        }
        case "help":
          push(
            "info",
            ["Commands: any `secapi` command works here (without the `secapi` prefix).", "Slash commands:", ...SLASH_COMMANDS.map((c) => `  /${c.name} — ${c.summary}`), "Keys: shift+tab cycle mode · ↑/↓ history · ctrl+l clear · ctrl+d exit"].join("\n"),
          )
          return true
        case "mode":
          setMode((m) => nextMode(m))
          return true
        case "cost":
          push(
            "info",
            ledger.current.calls() === 0
              ? `No metered API calls recorded yet (${sessionCalls} command(s) run).`
              : `Session cost: ${ledger.current.meterText()} · ${ledger.current.totalTokens()} tokens`,
          )
          return true
        case "status":
          push("info", `SEC API CLI v${options.version} · ${options.commandCount} commands · mode: ${mode}`)
          return true
        case "theme":
          push("info", "Run `config theme` or relaunch with --theme <name> to change the theme.")
          return true
        case "logout":
          push(
            "info",
            "To forget credentials, unset the API key env var (e.g. `unset SECAPI_API_KEY`) and `unset SECAPI_PROFILE` in your shell. The CLI never stores the key, so there is nothing to delete.",
          )
          return true
        case "skills":
          push(
            "info",
            [
              "Workflow shortcuts (type one to see its guided recipe):",
              ...SKILL_SHORTCUTS.map((s) => `  /${s.slash}${s.arg !== "none" ? ` <${s.arg}>` : ""}${skillIsMetered(s) ? " 💲" : ""} — ${s.summary}`),
            ].join("\n"),
          )
          return true
        default: {
          // Skill shortcut, e.g. /due-diligence AAPL → a guided run-view recipe.
          const shortcut = findSkillShortcut(parsed.name)
          if (shortcut) {
            if (shortcut.arg !== "none" && parsed.args.length === 0) {
              push("info", `${shortcut.title}: usage /${shortcut.slash} <${shortcut.arg}>`)
              return true
            }
            const steps = expandSkill(shortcut, parsed.args[0] ?? "")
            push(
              "info",
              [
                `${shortcut.title}${skillIsMetered(shortcut) ? "  💲 includes AI-metered steps" : ""}`,
                ...steps.map((s, i) => `  ${i + 1}. ${s.label}${s.metered ? " 💲" : ""}\n     ${s.command}`),
                "Run the steps above, or copy them into a script. (Auto-run is coming.)",
              ].join("\n"),
            )
            return true
          }
          push("error", `Unknown slash command: /${parsed.name}. Try /help or /skills.`)
          return true
        }
      }
    },
    [clearSession, exitRepl, push, replaceSessionEntries, running, saveCurrentSession, sessionCalls, mode, options.version, options.commandCount],
  )

  const submit = useCallback(
    async (line: string) => {
      const trimmed = line.trim()
      if (trimmed === "") return
      setHistory((h) => [...h, trimmed])
      setHistIndex(null)
      push("prompt", `${BRAND_MARK} ${trimmed}`)
      setInput("")
      let toRun = trimmed
      if (trimmed.startsWith("/")) {
        const parsed = parseSlash(trimmed)
        // A few slash commands map to real CLI commands (rich output captured below).
        if (parsed?.name === "login") {
          toRun = ["login", ...parsed.args].join(" ")
        } else if (parsed?.name === "personas") {
          toRun = "agents personas"
        } else if (parsed?.name === "prompts") {
          toRun = ["agents", "prompts", "list", ...parsed.args].join(" ")
        } else {
          handleSlash(trimmed)
          return
        }
      }
      if (mode === "plan") {
        push("info", commandPlan(toRun))
        return
      }
      if (mode === "ask") {
        push("info", askModeResponse(toRun))
        return
      }
      setRunning(true)
      setSessionCalls((n) => n + 1)
      const controller = new AbortController()
      abortRef.current = controller
      const result = await runCommand(toRun, {
        selfExec: options.selfExec,
        selfEntry: options.selfEntry,
        forwardedArgs: options.forwardedArgs,
        rich: true,
        signal: controller.signal,
      })
      abortRef.current = null
      setRunning(false)
      if (shouldTreatAsCancelled(result, controller.signal.aborted)) {
        push("info", "Command cancelled.")
        return
      }
      const cost = extractRequestSummary(result.stderr)
      if (cost) {
        ledger.current.record(cost)
        setMeterText(ledger.current.meterText())
      }
      if (result.stdout.trim() !== "") push("output", result.stdout.replace(/\n+$/, ""))
      if (cost) push("info", formatCostFooter(cost))
      // Show stderr but strip the (multi-line) request-summary JSON we parse for cost.
      const errText = stripRequestSummary(result.stderr)
      if (errText !== "") push(childStderrKind(result), errText)
    },
    [handleSlash, mode, options.forwardedArgs, options.selfExec, options.selfEntry, push],
  )

  useInput((ch, key) => {
    if (running) {
      if (key.ctrl && ch === "c") {
        abortRef.current?.abort()
        return
      }
      if (key.ctrl && ch === "d") {
        abortRef.current?.abort()
        exitRepl()
        return
      }
      if (key.ctrl && ch === "l") {
        push("info", "Command is still running. Press ctrl+c to cancel before clearing.")
      }
      return
    }

    if (key.ctrl && ch === "c") {
      if (paletteOpen) {
        setPaletteOpen(false)
        return
      }
      if (input !== "") {
        setInput("")
        return
      }
      if (ctrlCArmed) {
        exitRepl()
        return
      }
      setCtrlCArmed(true)
      push("info", "Press ctrl+c again to exit.")
      return
    }
    setCtrlCArmed(false)
    if (key.ctrl && ch === "d") {
      exitRepl()
      return
    }
    if (key.ctrl && ch === "l") {
      clearSession()
      return
    }

    // Command palette navigation takes priority while it is open.
    if (paletteOpen) {
      if (key.escape) {
        setPaletteOpen(false)
        return
      }
      if (key.upArrow) {
        setPaletteIndex((i) => Math.max(0, i - 1))
        return
      }
      if (key.downArrow) {
        setPaletteIndex((i) => Math.min(Math.max(0, palette.length - 1), i + 1))
        return
      }
      if (key.tab && key.shift) {
        setPaletteOpen(false)
        setMode((m) => nextMode(m))
        return
      }
      if (key.tab || key.return) {
        const chosen = palette[Math.min(paletteIndex, palette.length - 1)]
        if (chosen) {
          setInput(chosen.insert)
          setPaletteOpen(false)
          return
        }
        if (key.tab) return
      }
      // Fall through to text editing so the filter updates live.
    }

    if (key.tab && key.shift) {
      setMode((m) => nextMode(m))
      return
    }
    if (key.tab) {
      setPaletteOpen(true)
      setPaletteIndex(0)
      return
    }
    if (key.return) {
      void submit(input)
      return
    }
    if (key.upArrow) {
      if (history.length === 0) return
      const idx = histIndex === null ? history.length - 1 : Math.max(0, histIndex - 1)
      setHistIndex(idx)
      setInput(history[idx])
      return
    }
    if (key.downArrow) {
      if (histIndex === null) return
      const idx = histIndex + 1
      if (idx >= history.length) {
        setHistIndex(null)
        setInput("")
      } else {
        setHistIndex(idx)
        setInput(history[idx])
      }
      return
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1))
      return
    }
    if (ch && !key.ctrl && !key.meta) setInput((v) => v + ch)
  })

  const meta = modeMeta(mode)
  const indicator = modeIndicator(mode)
  const selected = Math.min(paletteIndex, Math.max(0, palette.length - 1))
  void stdout

  return (
    <Box flexDirection="column">
      <Banner version={options.version} commandCount={options.commandCount} />
      <Static key={epoch} items={items}>
        {(item) => (
          <Box key={item.id} marginBottom={item.kind === "output" ? 1 : 0}>
            <Text
              color={item.kind === "error" ? "red" : item.kind === "prompt" ? ACCENT : undefined}
              dimColor={item.kind === "info"}
            >
              {item.text}
            </Text>
          </Box>
        )}
      </Static>
      {running ? (
        <Text color={meta.color}>
          {SPINNER_FRAMES[spinner]} working…
        </Text>
      ) : (
        <Box>
          <Text color={meta.color}>
            {indicator ? `${indicator} ` : ""}
            {BRAND_MARK}{" "}
          </Text>
          <Text>{input}</Text>
          <Text inverse> </Text>
        </Box>
      )}
      {paletteOpen && palette.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {palette.map((entry, i) => (
            <Box key={entry.label}>
              <Text color={i === selected ? ACCENT : undefined} inverse={i === selected}>
                {entry.label}
              </Text>
              <Text dimColor>
                {"  "}
                {entry.metered ? "💲 " : ""}
                {entry.mutates ? "✎ " : ""}
                {entry.detail}
              </Text>
            </Box>
          ))}
          <Text dimColor>↑/↓ select · tab/enter insert · esc close</Text>
        </Box>
      ) : (
        <Text dimColor>
          {meta.label} · {options.commandCount} cmds · tab palette · shift+tab mode · /help
          {meterText ? ` · ◷ ${meterText}` : ""}
        </Text>
      )}
    </Box>
  )
}

export async function start(options: StartOptions): Promise<void> {
  const instance = render(<Repl {...options} />)
  await instance.waitUntilExit()
}
