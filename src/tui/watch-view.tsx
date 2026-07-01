// Ink full-screen live dashboard for `<command> --watch`. Loaded only via a
// dynamic import on the TTY watch path, so one-shot/piped runs never touch it.
// Each tick re-spawns the CLI for the command (rich output) and replaces the
// body; q quits, p pauses. The footer shows interval + cumulative session cost.
import { Box, render, Text, useApp, useInput } from "ink"
import React, { useCallback, useEffect, useState } from "react"
import { createCostLedger, extractRequestSummary } from "../cost/cost.ts"
import { runCommand } from "./exec.ts"

const SPINNER_FRAMES = ["⬒", "⬔", "⬓", "⬕"]
const ACCENT = "cyan"

export interface WatchStartOptions {
  command: string[]
  intervalMs: number
  selfExec: string
  selfEntry: string
  title: string
  forwardedArgs?: string[]
}

function WatchView(options: WatchStartOptions) {
  const { exit } = useApp()
  const [body, setBody] = useState("Loading…")
  const [ticks, setTicks] = useState(0)
  const [spin, setSpin] = useState(0)
  const [paused, setPaused] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [clock, setClock] = useState(new Date().toLocaleTimeString())
  const ledger = React.useRef(createCostLedger())
  // Guards against overlapping runs: if a refresh is slower than the interval,
  // the next tick (or a manual `r`) is skipped rather than spawning a second
  // child command on top of the first.
  const inFlight = React.useRef(false)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    try {
      const result = await runCommand(options.command.join(" "), {
        selfExec: options.selfExec,
        selfEntry: options.selfEntry,
        forwardedArgs: options.forwardedArgs,
        rich: true,
      })
      const cost = extractRequestSummary(result.stderr)
      if (cost) ledger.current.record(cost)
      setBody(result.stdout.trim() || result.stderr.trim() || "(no output)")
      setClock(new Date().toLocaleTimeString())
      setTicks((t) => t + 1)
    } finally {
      inFlight.current = false
      setRefreshing(false)
    }
  }, [options.command, options.forwardedArgs, options.selfExec, options.selfEntry])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (paused) return
    const timer = setInterval(() => void refresh(), options.intervalMs)
    return () => clearInterval(timer)
  }, [paused, refresh, options.intervalMs])

  useEffect(() => {
    if (!refreshing) return
    const t = setInterval(() => setSpin((s) => (s + 1) % SPINNER_FRAMES.length), 120)
    return () => clearInterval(t)
  }, [refreshing])

  useInput((input, key) => {
    if (input === "q" || key.escape || (key.ctrl && input === "c")) exit()
    if (input === "p") setPaused((p) => !p)
    if (input === "r") void refresh()
  })

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={ACCENT} bold>
          ◈ {options.title}
        </Text>
        <Text dimColor>
          {"  "}
          {refreshing ? `${SPINNER_FRAMES[spin]} ` : ""}
          {clock} · live{paused ? " (paused)" : ""}
        </Text>
      </Box>
      <Text dimColor>{"─".repeat(48)}</Text>
      <Box marginY={1}>
        <Text>{body}</Text>
      </Box>
      <Text dimColor>{"─".repeat(48)}</Text>
      <Text dimColor>
        every {Math.round(options.intervalMs / 1000)}s · {ticks} refresh{ticks === 1 ? "" : "es"} · ◷{" "}
        {ledger.current.meterText()} · q quit · p {paused ? "resume" : "pause"} · r refresh now
      </Text>
    </Box>
  )
}

export async function start(options: WatchStartOptions): Promise<void> {
  const instance = render(<WatchView {...options} />)
  await instance.waitUntilExit()
}
