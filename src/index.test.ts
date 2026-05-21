import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"

const cliEntry = new URL("./index.ts", import.meta.url)
const secretValues = [
  "ods_live_ARGV_SHOULD_NOT_LEAK",
  "bearer_ARGV_SHOULD_NOT_LEAK",
  "ods_live_ENV_BACKED_AUTH",
  "bearer_ENV_BACKED_AUTH",
  "opr_live_OPERATOR_ALIAS_AUTH",
  "ods_live_DATASTREAM_OPERATOR_AUTH",
  "secapi_live_ENV_BACKED_AUTH",
  "ods_live_STDIN_BACKED_AUTH",
  "bearer_STDIN_BACKED_AUTH",
]

type CapturedRequest = {
  path: string
  headers: Record<string, string>
}

let server: ReturnType<typeof Bun.serve>
let requests: CapturedRequest[] = []

async function runCli(command: string[], options: {
  env?: Record<string, string | undefined>
  input?: string
} = {}) {
  const env = { ...process.env }
  for (const name of [
    "SECAPI_API_KEY",
    "SECAPI_BASE_URL",
    "SECAPI_BEARER_TOKEN",
    "SECAPI_OPERATOR_API_KEY",
    "SECAPI_API_BASE_URL",
    "OMNI_DATASTREAM_API_KEY",
    "OMNI_OPERATOR_API_KEY",
    "OMNI_DATASTREAM_OPERATOR_API_KEY",
    "OMNI_DATASTREAM_BEARER_TOKEN",
    "OMNI_DATASTREAM_BASE_URL",
  ]) {
    delete env[name]
  }

  return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry.pathname, ...command], {
      env: {
        ...env,
        SECAPI_BASE_URL: `http://127.0.0.1:${server.port}`,
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (status) => resolve({ status, stdout, stderr }))
    if (options.input !== undefined) {
      child.stdin.end(options.input)
    } else {
      child.stdin.end()
    }
  })
}

function assertNoSecretLeak(stdout: string, stderr: string) {
  for (const secret of secretValues) {
    expect(stdout.includes(secret)).toBe(false)
    expect(stderr.includes(secret)).toBe(false)
  }
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push({
        path: url.pathname,
        headers: Object.fromEntries(request.headers.entries()),
      })
      return Response.json({ ok: true })
    },
  })
})

beforeEach(() => {
  requests = []
})

afterAll(() => {
  server.stop(true)
})

describe("CLI credential handling", () => {
  test("--api-key argv credentials fail without echoing the secret", async () => {
    const result = await runCli(["health", "--api-key", "ods_live_ARGV_SHOULD_NOT_LEAK"])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--api-key is no longer supported")
    expect(result.stderr).toContain("SECAPI_API_KEY")
    expect(result.stderr).toContain("OMNI_DATASTREAM_API_KEY")
    expect(result.stderr).toContain("--api-key-stdin")
    assertNoSecretLeak(result.stdout, result.stderr)
    expect(requests).toHaveLength(0)
  })

  test("--bearer-token argv credentials fail without echoing the secret", async () => {
    const result = await runCli(["agent", "bootstrap-token", "--bearer-token=bearer_ARGV_SHOULD_NOT_LEAK"])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("--bearer-token is no longer supported")
    expect(result.stderr).toContain("SECAPI_BEARER_TOKEN")
    expect(result.stderr).toContain("OMNI_DATASTREAM_BEARER_TOKEN")
    expect(result.stderr).toContain("--bearer-token-stdin")
    assertNoSecretLeak(result.stdout, result.stderr)
    expect(requests).toHaveLength(0)
  })

  test("OMNI_DATASTREAM_API_KEY env auth sends x-api-key", async () => {
    const result = await runCli(["health"], {
      env: { OMNI_DATASTREAM_API_KEY: "ods_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.path).toBe("/healthz")
    expect(requests[0]?.headers["x-api-key"]).toBe("ods_live_ENV_BACKED_AUTH")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("SECAPI_API_KEY env auth sends x-api-key", async () => {
    const result = await runCli(["health"], {
      env: { SECAPI_API_KEY: "secapi_live_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.path).toBe("/healthz")
    expect(requests[0]?.headers["x-api-key"]).toBe("secapi_live_ENV_BACKED_AUTH")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("OMNI_OPERATOR_API_KEY env alias sends x-api-key", async () => {
    const result = await runCli(["health"], {
      env: { OMNI_OPERATOR_API_KEY: "opr_live_OPERATOR_ALIAS_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.headers["x-api-key"]).toBe("opr_live_OPERATOR_ALIAS_AUTH")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("OMNI_DATASTREAM_OPERATOR_API_KEY env convention still sends x-api-key", async () => {
    const result = await runCli(["health"], {
      env: { OMNI_DATASTREAM_OPERATOR_API_KEY: "ods_live_DATASTREAM_OPERATOR_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.headers["x-api-key"]).toBe("ods_live_DATASTREAM_OPERATOR_AUTH")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("OMNI_DATASTREAM_BEARER_TOKEN env auth sends bearer token", async () => {
    const result = await runCli(["health"], {
      env: { OMNI_DATASTREAM_BEARER_TOKEN: "bearer_ENV_BACKED_AUTH" },
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.headers.authorization).toBe("Bearer bearer_ENV_BACKED_AUTH")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("--api-key-stdin reads x-api-key from stdin", async () => {
    const result = await runCli(["health", "--api-key-stdin"], {
      input: "ods_live_STDIN_BACKED_AUTH\n",
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.headers["x-api-key"]).toBe("ods_live_STDIN_BACKED_AUTH")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("--bearer-token-stdin reads bearer token from stdin", async () => {
    const result = await runCli(["health", "--bearer-token-stdin"], {
      input: "bearer_STDIN_BACKED_AUTH\n",
    })

    expect(result.status).toBe(0)
    expect(requests[0]?.headers.authorization).toBe("Bearer bearer_STDIN_BACKED_AUTH")
    assertNoSecretLeak(result.stdout, result.stderr)
  })

  test("package exposes secapi bin alias alongside omni-sec", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json()

    expect(packageJson.bin.secapi).toBe("dist/index.js")
    expect(packageJson.bin["omni-sec"]).toBe("dist/index.js")
  })
})
