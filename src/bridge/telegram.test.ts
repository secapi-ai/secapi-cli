import { describe, expect, test } from "bun:test"
import { formatReply, pollOnce, processUpdate, telegramApiUrl, type BridgeDeps, type TelegramUpdate } from "./telegram.ts"

function fakeDeps(overrides: Partial<BridgeDeps> = {}): { deps: BridgeDeps; sent: Array<{ chatId: number; text: string }>; ran: string[][]; logs: string[] } {
  const sent: Array<{ chatId: number; text: string }> = []
  const ran: string[][] = []
  const logs: string[] = []
  const deps: BridgeDeps = {
    fetchUpdates: async () => [],
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text })
    },
    runCommand: async (tokens) => {
      ran.push(tokens)
      return { stdout: `ran: ${tokens.join(" ")}`, stderr: "", code: 0 }
    },
    isBlocked: () => false,
    allowedChatId: 42,
    writeLog: (line) => logs.push(line),
    ...overrides,
  }
  return { deps, sent, ran, logs }
}

describe("processUpdate", () => {
  test("runs an allowed command from the allow-listed chat and replies with its output", async () => {
    const { deps, sent, ran } = fakeDeps()
    await processUpdate(
      { update_id: 1, message: { message_id: 1, chat: { id: 42 }, text: "health" } },
      deps,
    )
    expect(ran).toEqual([["health"]])
    expect(sent).toHaveLength(1)
    expect(sent[0]!.chatId).toBe(42)
    expect(sent[0]!.text).toContain("ran: health")
  })

  test("silently ignores messages from any chat other than the allow-listed one", async () => {
    const { deps, sent, ran, logs } = fakeDeps()
    await processUpdate(
      { update_id: 1, message: { message_id: 1, chat: { id: 999 }, text: "health" } },
      deps,
    )
    expect(ran).toHaveLength(0)
    expect(sent).toHaveLength(0)
    expect(logs[0]).toContain("unauthorized chat 999")
  })

  test("refuses a blocked (mutating or unrecognized) command instead of running it", async () => {
    const { deps, sent, ran } = fakeDeps({ isBlocked: () => true })
    await processUpdate(
      { update_id: 1, message: { message_id: 1, chat: { id: 42 }, text: "streams create --transport websocket" } },
      deps,
    )
    expect(ran).toHaveLength(0)
    expect(sent[0]!.text).toContain("not allowed via the remote bridge")
  })

  test("ignores updates with no message text (e.g. photos, stickers)", async () => {
    const { deps, sent, ran } = fakeDeps()
    await processUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 42 } } }, deps)
    expect(ran).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })
})

describe("pollOnce", () => {
  test("processes every update in the batch and advances the offset past the last one", async () => {
    const updates: TelegramUpdate[] = [
      { update_id: 5, message: { message_id: 1, chat: { id: 42 }, text: "health" } },
      { update_id: 6, message: { message_id: 2, chat: { id: 42 }, text: "me" } },
    ]
    const { deps, ran } = fakeDeps({ fetchUpdates: async () => updates })
    const nextOffset = await pollOnce(undefined, deps)
    expect(ran).toEqual([["health"], ["me"]])
    expect(nextOffset).toBe(7)
  })

  test("returns the same offset when there are no updates", async () => {
    const { deps } = fakeDeps({ fetchUpdates: async () => [] })
    expect(await pollOnce(3, deps)).toBe(3)
  })
})

describe("formatReply", () => {
  test("wraps stdout in a code fence", () => {
    expect(formatReply({ stdout: "hello", stderr: "", code: 0 })).toBe("```\nhello\n```")
  })

  test("falls back to stderr, then a placeholder, when stdout is empty", () => {
    expect(formatReply({ stdout: "", stderr: "boom", code: 1 })).toBe("```\nboom\n```")
    expect(formatReply({ stdout: "", stderr: "", code: 0 })).toBe("```\n(no output)\n```")
  })

  test("truncates very long output to stay under Telegram's message cap", () => {
    const huge = "x".repeat(10_000)
    const reply = formatReply({ stdout: huge, stderr: "", code: 0 })
    expect(reply.length).toBeLessThan(4096)
  })
})

describe("telegramApiUrl", () => {
  test("builds the bot API URL without ever appearing to log the token separately", () => {
    expect(telegramApiUrl("123:abc", "getUpdates")).toBe("https://api.telegram.org/bot123:abc/getUpdates")
  })
})
