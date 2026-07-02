// Orchestrates `secapi streams watch` — feeds WS filing-stream events to a
// per-event writer, either as a rich styled line (TTY) or raw NDJSON (pipe/
// agent — one self-describing JSON object per line, filterable by `.event`).
// Resolves once `maxEvents` filing.published events have arrived, or the
// stop signal fires (SIGINT in production). Pure/injectable so this is
// testable without a real WebSocket — index.ts wires `openStream` to
// `apiClient.streamFilings()`.

import { formatFilingStreamEvent } from "../render/cards.ts"
import type { Theme } from "../theme/theme.ts"

export interface StreamHandle {
  close(): void
}

export interface OpenStreamCallbacks {
  onConnected: (event: Record<string, unknown>) => void
  onFiling: (event: Record<string, unknown>) => void
  onRateLimited: (event: Record<string, unknown>) => void
  onError: (error: unknown) => void
}

export interface StreamWatchOptions {
  streamId: string
  forms?: string[]
  tickers?: string[]
  /** Stop after this many filing.published events. Undefined = run until the stop signal. */
  maxEvents?: number
  /**
   * Give up (reject) after this many consecutive stream errors with no
   * intervening successful connect/filing — e.g. a bad API key, an
   * unreachable base URL, or a non-websocket stream id all fail every
   * retry attempt forever. Without this, `streamFilings()`'s default
   * auto-reconnect means the command hangs indefinitely on stderr-only
   * noise and (if the user interrupts it) exits 0 having delivered
   * nothing — indistinguishable from a quiet, healthy stream to a script.
   * Defaults to 5.
   */
  maxConsecutiveErrors?: number
  rich: boolean
  theme: Theme
  write: (line: string) => void
  writeError: (line: string) => void
  openStream: (
    streamId: string,
    forms: string[] | undefined,
    tickers: string[] | undefined,
    callbacks: OpenStreamCallbacks,
  ) => StreamHandle
  /** Registers the stop handler (default: process SIGINT). Injectable for tests. */
  onStopSignal?: (stop: () => void) => void
}

export function runStreamWatch(options: StreamWatchOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let filingCount = 0
    let consecutiveErrors = 0
    let settled = false
    let handle: StreamHandle | null = null
    // A test double (or a very fast real connection) can invoke callbacks
    // synchronously from inside openStream(), before it has returned and
    // `handle` is assigned — finish helpers must still close it once it exists.
    let closeOnAssign = false
    const maxConsecutiveErrors = options.maxConsecutiveErrors ?? 5

    const emit = (event: Record<string, unknown>) => {
      options.write(options.rich ? formatFilingStreamEvent(options.theme, event) : JSON.stringify(event))
    }
    const closeHandle = () => {
      if (handle) handle.close()
      else closeOnAssign = true
    }
    const finishOk = () => {
      if (settled) return
      settled = true
      closeHandle()
      resolve()
    }
    const finishError = (message: string) => {
      if (settled) return
      settled = true
      closeHandle()
      reject(new Error(message))
    }

    handle = options.openStream(options.streamId, options.forms, options.tickers, {
      onConnected: (event) => {
        consecutiveErrors = 0
        emit(event)
      },
      onFiling: (event) => {
        consecutiveErrors = 0
        emit(event)
        filingCount += 1
        if (options.maxEvents !== undefined && filingCount >= options.maxEvents) finishOk()
      },
      onRateLimited: (event) => emit(event),
      onError: (error) => {
        consecutiveErrors += 1
        const message = error instanceof Error ? error.message : String(error)
        options.writeError(`stream error: ${message}`)
        if (consecutiveErrors >= maxConsecutiveErrors) {
          finishError(`giving up after ${maxConsecutiveErrors} consecutive stream errors — last error: ${message}`)
        }
      },
    })
    if (closeOnAssign) handle.close()

    const registerStop = options.onStopSignal ?? ((stop: () => void) => process.once("SIGINT", stop))
    registerStop(finishOk)
  })
}
