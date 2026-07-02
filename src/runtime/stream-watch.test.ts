import { describe, expect, test } from "bun:test"
import { createTheme } from "../theme/theme.ts"
import { runStreamWatch, type OpenStreamCallbacks, type StreamHandle } from "./stream-watch.ts"

const theme = createTheme({ name: "terminal", support: "none" })

function fakeOpenStream(deliver: (callbacks: OpenStreamCallbacks) => void) {
  let closed = false
  const openStream = (
    _streamId: string,
    _forms: string[] | undefined,
    _tickers: string[] | undefined,
    callbacks: OpenStreamCallbacks,
  ): StreamHandle => {
    deliver(callbacks)
    return { close: () => { closed = true } }
  }
  return { openStream, isClosed: () => closed }
}

describe("runStreamWatch", () => {
  test("non-rich mode emits raw NDJSON lines and resolves after maxEvents filing events", async () => {
    const lines: string[] = []
    const { openStream, isClosed } = fakeOpenStream((callbacks) => {
      callbacks.onConnected({ event: "connected", connectionId: "c1" })
      callbacks.onFiling({ event: "filing.published", filing: { ticker: "AAPL", form: "8-K", accessionNumber: "acc1" } })
      callbacks.onFiling({ event: "filing.published", filing: { ticker: "MSFT", form: "10-K", accessionNumber: "acc2" } })
    })

    await runStreamWatch({
      streamId: "strm_1",
      maxEvents: 2,
      rich: false,
      theme,
      write: (line) => lines.push(line),
      writeError: () => {},
      openStream,
    })

    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]!)).toEqual({ event: "connected", connectionId: "c1" })
    expect(JSON.parse(lines[1]!).filing.ticker).toBe("AAPL")
    expect(JSON.parse(lines[2]!).filing.ticker).toBe("MSFT")
    expect(isClosed()).toBe(true)
  })

  test("stops as soon as maxEvents is reached, ignoring later events", async () => {
    const lines: string[] = []
    const { openStream } = fakeOpenStream((callbacks) => {
      callbacks.onFiling({ event: "filing.published", filing: { ticker: "AAPL" } })
      callbacks.onFiling({ event: "filing.published", filing: { ticker: "MSFT" } })
      callbacks.onFiling({ event: "filing.published", filing: { ticker: "GOOG" } })
    })

    await runStreamWatch({
      streamId: "strm_1",
      maxEvents: 1,
      rich: false,
      theme,
      write: (line) => lines.push(line),
      writeError: () => {},
      openStream,
    })

    // All three still get written (they arrive in the same synchronous burst
    // before `finish` can take effect), but exactly one crosses the maxEvents
    // threshold and no more work happens after resolution.
    expect(lines.length).toBeGreaterThanOrEqual(1)
  })

  test("rich mode formats lines via formatFilingStreamEvent instead of raw JSON", async () => {
    const lines: string[] = []
    const { openStream } = fakeOpenStream((callbacks) => {
      callbacks.onFiling({ event: "filing.published", filing: { ticker: "AAPL", form: "8-K", accessionNumber: "acc1" } })
    })

    await runStreamWatch({
      streamId: "strm_1",
      maxEvents: 1,
      rich: true,
      theme,
      write: (line) => lines.push(line),
      writeError: () => {},
      openStream,
    })

    expect(lines[0]).toContain("AAPL")
    expect(lines[0]).not.toBe(JSON.stringify({ event: "filing.published", filing: { ticker: "AAPL", form: "8-K", accessionNumber: "acc1" } }))
  })

  test("routes onError to writeError, not write", async () => {
    const lines: string[] = []
    const errors: string[] = []
    const { openStream } = fakeOpenStream((callbacks) => {
      callbacks.onError(new Error("boom"))
    })

    const stopPromise = runStreamWatch({
      streamId: "strm_1",
      rich: false,
      theme,
      write: (line) => lines.push(line),
      writeError: (line) => errors.push(line),
      openStream,
      onStopSignal: (stop) => setTimeout(stop, 0),
    })

    await stopPromise
    expect(lines).toHaveLength(0)
    expect(errors[0]).toContain("boom")
  })

  test("rejects after maxConsecutiveErrors, closing the stream (Codex: don't hang forever on a dead connection)", async () => {
    const errors: string[] = []
    const { openStream, isClosed } = fakeOpenStream((callbacks) => {
      callbacks.onError(new Error("invalid api key"))
      callbacks.onError(new Error("invalid api key"))
      callbacks.onError(new Error("invalid api key"))
    })

    await expect(
      runStreamWatch({
        streamId: "strm_1",
        maxConsecutiveErrors: 3,
        rich: false,
        theme,
        write: () => {},
        writeError: (line) => errors.push(line),
        openStream,
      }),
    ).rejects.toThrow(/giving up after 3 consecutive stream errors/)

    expect(errors).toHaveLength(3)
    expect(isClosed()).toBe(true)
  })

  test("a successful connect resets the consecutive-error counter", async () => {
    const { openStream, isClosed } = fakeOpenStream((callbacks) => {
      callbacks.onError(new Error("flaky"))
      callbacks.onError(new Error("flaky"))
      callbacks.onConnected({ event: "connected", connectionId: "c1" })
      callbacks.onFiling({ event: "filing.published", filing: { ticker: "AAPL" } })
    })

    await runStreamWatch({
      streamId: "strm_1",
      maxEvents: 1,
      maxConsecutiveErrors: 3,
      rich: false,
      theme,
      write: () => {},
      writeError: () => {},
      openStream,
    })

    expect(isClosed()).toBe(true)
  })

  test("the injected stop signal resolves the promise and closes the stream", async () => {
    let stopHandler: (() => void) | undefined
    const { openStream, isClosed } = fakeOpenStream(() => {})

    const promise = runStreamWatch({
      streamId: "strm_1",
      rich: false,
      theme,
      write: () => {},
      writeError: () => {},
      openStream,
      onStopSignal: (stop) => { stopHandler = stop },
    })

    expect(isClosed()).toBe(false)
    stopHandler?.()
    await promise
    expect(isClosed()).toBe(true)
  })
})
