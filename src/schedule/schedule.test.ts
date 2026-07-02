import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildScheduleNotifyPayload,
  describeSpec,
  isDue,
  loadSchedules,
  nextRunMs,
  parseSchedule,
  parseSchedules,
  saveSchedules,
  type ScheduledTask,
} from "./schedule.ts"

describe("parseSchedule", () => {
  test("every weekday at 7am", () => {
    expect(parseSchedule("every weekday at 7am")).toEqual({ kind: "weekday", hour: 7, minute: 0 })
  })
  test("daily 9:30am", () => {
    expect(parseSchedule("daily at 9:30am")).toEqual({ kind: "daily", hour: 9, minute: 30 })
  })
  test("every monday 8am → weekly weekday=1", () => {
    expect(parseSchedule("every monday at 8am")).toEqual({ kind: "weekly", weekday: 1, hour: 8, minute: 0 })
  })
  test("hourly + interval", () => {
    expect(parseSchedule("hourly")).toEqual({ kind: "hourly", minute: 0 })
    expect(parseSchedule("every 15 minutes")).toEqual({ kind: "interval", intervalMinutes: 15 })
    expect(parseSchedule("every 2 hours")).toEqual({ kind: "interval", intervalMinutes: 120 })
  })
  test("pm conversion + bare time defaults to daily", () => {
    expect(parseSchedule("at 2:00pm")).toEqual({ kind: "daily", hour: 14, minute: 0 })
  })
  test("unrecognized → null", () => {
    expect(parseSchedule("whenever I feel like it")).toBeNull()
    expect(parseSchedule("")).toBeNull()
  })
})

describe("describeSpec / nextRunMs / isDue", () => {
  test("describeSpec is human readable", () => {
    expect(describeSpec({ kind: "weekday", hour: 7, minute: 0 })).toBe("weekdays at 07:00")
    expect(describeSpec({ kind: "interval", intervalMinutes: 30 })).toBe("every 30 min")
  })

  test("daily nextRun is strictly after `from` at the configured time", () => {
    const from = new Date("2026-06-30T10:00:00").getTime() // 10:00 local
    const next = new Date(nextRunMs({ kind: "daily", hour: 7, minute: 0 }, from))
    expect(next.getHours()).toBe(7)
    expect(next.getTime()).toBeGreaterThan(from)
  })

  test("interval nextRun adds the interval", () => {
    const from = 1_000_000
    expect(nextRunMs({ kind: "interval", intervalMinutes: 5 }, from)).toBe(from + 5 * 60_000)
  })

  test("weekday nextRun lands on Mon–Fri", () => {
    // Saturday 2026-07-04 12:00 local → next weekday run should be Mon..Fri
    const sat = new Date("2026-07-04T12:00:00").getTime()
    const next = new Date(nextRunMs({ kind: "weekday", hour: 7, minute: 0 }, sat))
    expect(next.getDay()).toBeGreaterThanOrEqual(1)
    expect(next.getDay()).toBeLessThanOrEqual(5)
  })

  test("isDue true once the next run after lastRun has passed", () => {
    const task: ScheduledTask = {
      id: "t",
      command: "x",
      spec: { kind: "interval", intervalMinutes: 10 },
      description: "every 10 min",
      createdAt: new Date("2026-06-30T00:00:00.000Z").toISOString(),
      lastRunMs: 1_000_000,
    }
    expect(isDue(task, 1_000_000 + 9 * 60_000)).toBe(false)
    expect(isDue(task, 1_000_000 + 11 * 60_000)).toBe(true)
  })
})

describe("persistence", () => {
  test("save/load round-trip at 0600; parseSchedules drops malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "secapi-sched-"))
    try {
      const env = { SECAPI_SCHEDULE_FILE: join(dir, "s.json") } as NodeJS.ProcessEnv
      const task: ScheduledTask = {
        id: "sch_1",
        command: "filings latest --ticker AAPL",
        spec: { kind: "weekday", hour: 7, minute: 0 },
        description: "weekdays at 07:00",
        createdAt: "2026-06-30T00:00:00.000Z",
      }
      const path = saveSchedules(env, dir, [task])
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(loadSchedules(env, dir).map((t) => t.id)).toEqual(["sch_1"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("parseSchedules tolerates garbage", () => {
    expect(parseSchedules(null)).toEqual([])
    expect(parseSchedules("not json")).toEqual([])
    expect(parseSchedules(JSON.stringify({ tasks: [{}, { id: "ok", command: "c" }] })).length).toBe(1)
  })
})

describe("buildScheduleNotifyPayload", () => {
  const task: ScheduledTask = {
    id: "sch_1",
    command: "filings latest --ticker AAPL",
    spec: { kind: "daily", hour: 7, minute: 0 },
    description: "daily at 07:00",
    createdAt: "2026-06-30T00:00:00.000Z",
    notifyWebhookUrl: "https://example.com/hook",
  }

  test("builds a schedule.completed event with the task id, command, and result", () => {
    const payload = buildScheduleNotifyPayload(task, { ok: true, durationMs: 412, output: '{"ticker":"AAPL"}' })
    expect(payload).toEqual({
      event: "schedule.completed",
      taskId: "sch_1",
      command: "filings latest --ticker AAPL",
      ok: true,
      durationMs: 412,
      output: '{"ticker":"AAPL"}',
    })
  })

  test("redacts secret-shaped output the same way session transcripts are redacted", () => {
    const payload = buildScheduleNotifyPayload(task, { ok: false, durationMs: 10, output: "auth failed for secapi_live_SHOULD_NOT_LEAK" })
    expect(payload.output).not.toContain("secapi_live_SHOULD_NOT_LEAK")
    expect(payload.output).toContain("[redacted]")
  })

  test("also redacts a secret-shaped stored command, not just output (Codex review, PR #1207)", () => {
    const taskWithSecretInCommand: ScheduledTask = {
      ...task,
      command: "filings latest --api-key secapi_live_SHOULD_NOT_LEAK --ticker AAPL",
    }
    const payload = buildScheduleNotifyPayload(taskWithSecretInCommand, { ok: true, durationMs: 10, output: "" })
    expect(payload.command).not.toContain("secapi_live_SHOULD_NOT_LEAK")
    expect(payload.command).toContain("[redacted]")
  })
})
