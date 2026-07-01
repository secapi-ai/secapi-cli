import { describe, expect, test } from "bun:test"
import { runCommand, tokenizeCommand, type Spawner } from "./exec.ts"

describe("tokenizeCommand", () => {
  test("splits on whitespace", () => {
    expect(tokenizeCommand("filings latest --ticker AAPL")).toEqual(["filings", "latest", "--ticker", "AAPL"])
  })
  test("honors double and single quotes", () => {
    expect(tokenizeCommand('search fulltext --q "supply chain"')).toEqual(["search", "fulltext", "--q", "supply chain"])
    expect(tokenizeCommand("x --q 'going concern'")).toEqual(["x", "--q", "going concern"])
  })
  test("empty input → no tokens", () => {
    expect(tokenizeCommand("   ")).toEqual([])
  })
})

describe("runCommand", () => {
  test("spawns self with parsed argv and forces rich output when rich=true", async () => {
    const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    const spawner: Spawner = async (cmd, args, env) => {
      calls.push({ cmd, args, env })
      return { stdout: "OK", stderr: "", code: 0 }
    }
    const res = await runCommand("filings latest --ticker AAPL", {
      selfExec: "/usr/bin/node",
      selfEntry: "/cli/index.js",
      rich: true,
      spawner,
      baseEnv: {},
    })
    expect(res).toEqual({ stdout: "OK", stderr: "", code: 0 })
    expect(calls[0].cmd).toBe("/usr/bin/node")
    // rich runs append --request-summary so the REPL can parse cost from stderr
    expect(calls[0].args).toEqual(["/cli/index.js", "filings", "latest", "--ticker", "AAPL", "--request-summary=true"])
    expect(calls[0].env.SECAPI_TUI).toBe("1")
    expect(calls[0].env.FORCE_COLOR).toBe("3")
  })

  test("forwards parent global flags into spawned commands", async () => {
    const calls: Array<{ args: string[] }> = []
    const spawner: Spawner = async (_cmd, args) => {
      calls.push({ args })
      return { stdout: "OK", stderr: "", code: 0 }
    }
    await runCommand("health", {
      selfExec: "/usr/bin/node",
      selfEntry: "/cli/index.js",
      rich: true,
      forwardedArgs: ["--profile", "staging", "--base-url", "http://127.0.0.1:8787"],
      spawner,
      baseEnv: {},
    })
    expect(calls[0].args).toEqual(["/cli/index.js", "--profile", "staging", "--base-url", "http://127.0.0.1:8787", "health", "--request-summary=true"])
  })

  test("command-local global flags override forwarded REPL globals", async () => {
    const calls: Array<{ args: string[] }> = []
    const spawner: Spawner = async (_cmd, args) => {
      calls.push({ args })
      return { stdout: "OK", stderr: "", code: 0 }
    }
    await runCommand("login --profile prod --base-url https://api.secapi.ai", {
      selfExec: "/usr/bin/node",
      selfEntry: "/cli/index.js",
      rich: true,
      forwardedArgs: ["--profile", "staging", "--base-url", "http://127.0.0.1:8787", "--theme", "xai"],
      spawner,
      baseEnv: {},
    })
    expect(calls[0].args).toEqual(["/cli/index.js", "--theme", "xai", "login", "--profile", "prod", "--base-url", "https://api.secapi.ai", "--request-summary=true"])
  })

  test("--request-summary uses inline true so trailing value flags cannot consume it", async () => {
    const calls: Array<{ args: string[] }> = []
    const spawner: Spawner = async (_cmd, args) => {
      calls.push({ args })
      return { stdout: "", stderr: "", code: 0 }
    }
    await runCommand("filings latest --ticker", {
      selfExec: "/usr/bin/node",
      selfEntry: "/cli/index.js",
      rich: true,
      spawner,
      baseEnv: {},
    })
    expect(calls[0].args).toEqual(["/cli/index.js", "filings", "latest", "--ticker", "--request-summary=true"])
  })

  test("stdin credential flags are rejected before spawning inside the REPL", async () => {
    let spawned = false
    const spawner: Spawner = async () => {
      spawned = true
      return { stdout: "", stderr: "", code: 0 }
    }
    const res = await runCommand("login --api-key-stdin", {
      selfExec: "/usr/bin/node",
      selfEntry: "/cli/index.js",
      rich: true,
      spawner,
      baseEnv: {},
    })
    expect(spawned).toBe(false)
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("stdin credential flags are unavailable")
  })

  test("rich REPL children clear inherited NO_COLOR", async () => {
    let captured: NodeJS.ProcessEnv = {}
    const spawner: Spawner = async (_cmd, _args, env) => {
      captured = env
      return { stdout: "", stderr: "", code: 0 }
    }
    await runCommand("me", { selfExec: "node", selfEntry: "x", rich: true, spawner, baseEnv: { NO_COLOR: "1" } })
    expect(captured.SECAPI_TUI).toBe("1")
    expect(captured.NO_COLOR).toBeUndefined()
  })

  test("passes abort signals to the spawner", async () => {
    const controller = new AbortController()
    let captured: AbortSignal | undefined
    const spawner: Spawner = async (_cmd, _args, _env, signal) => {
      captured = signal
      return { stdout: "", stderr: "", code: 130 }
    }
    await runCommand("me", { selfExec: "node", selfEntry: "x", rich: true, spawner, signal: controller.signal })
    expect(captured).toBe(controller.signal)
  })

  test("does not force rich when rich=false", async () => {
    let captured: NodeJS.ProcessEnv = {}
    const spawner: Spawner = async (_cmd, _args, env) => {
      captured = env
      return { stdout: "", stderr: "", code: 0 }
    }
    await runCommand("me", { selfExec: "node", selfEntry: "x", rich: false, spawner, baseEnv: {} })
    expect(captured.SECAPI_TUI).toBeUndefined()
  })

  test("aborting the signal is threaded to the spawner (kills a hung child)", async () => {
    let killed = false
    const spawner: Spawner = (_cmd, _args, _env, signal) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          killed = true
          resolve({ stdout: "", stderr: "", code: 130 })
        })
        // Otherwise never resolves — simulates a hung child.
      })
    const controller = new AbortController()
    const promise = runCommand("filings latest", {
      selfExec: "n",
      selfEntry: "e",
      rich: true,
      spawner,
      signal: controller.signal,
      baseEnv: {},
    })
    controller.abort()
    const res = await promise
    expect(killed).toBe(true)
    expect(res.code).toBe(130)
  })

  test("empty input returns a no-op result without spawning", async () => {
    let spawned = false
    const spawner: Spawner = async () => {
      spawned = true
      return { stdout: "", stderr: "", code: 0 }
    }
    const res = await runCommand("   ", { selfExec: "n", selfEntry: "e", rich: true, spawner })
    expect(spawned).toBe(false)
    expect(res.code).toBe(0)
  })
})
