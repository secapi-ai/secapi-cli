// Natural-language scheduling (Grok /schedule, finance-adapted): turn
// "every weekday at 7am" into a normalized spec, persist scheduled `secapi`
// commands, and compute which are due. The CLI doesn't run a long-lived daemon;
// `secapi schedule run-due` is meant to be invoked by the OS scheduler
// (cron/launchd/Task Scheduler) — robust and testable. Parsing + due-computation
// are pure.

export type ScheduleKind = "interval" | "hourly" | "daily" | "weekday" | "weekly"

export interface ScheduleSpec {
  kind: ScheduleKind
  /** 0–23, for daily/weekday/weekly/hourly (hourly ignores it). */
  hour?: number
  /** 0–59. */
  minute?: number
  /** 0=Sun..6=Sat, for weekly. */
  weekday?: number
  /** for interval kind. */
  intervalMinutes?: number
}

const WEEKDAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }

function parseTime(text: string): { hour: number; minute: number } | null {
  // 7am / 9:30am / 14:00 / 7 am
  const m = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (!m) return null
  let hour = Number.parseInt(m[1], 10)
  const minute = m[2] ? Number.parseInt(m[2], 10) : 0
  const ampm = m[3]?.toLowerCase()
  if (ampm === "pm" && hour < 12) hour += 12
  if (ampm === "am" && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

/** Parse a natural-language schedule, or return null if unrecognized. */
export function parseSchedule(input: string): ScheduleSpec | null {
  const text = input.trim().toLowerCase()
  if (text === "") return null

  const everyN = text.match(/every\s+(\d+)\s*(min|minute|minutes|hour|hours)/)
  if (everyN) {
    const n = Number.parseInt(everyN[1], 10)
    const unit = everyN[2]
    if (n <= 0) return null
    return { kind: "interval", intervalMinutes: unit.startsWith("hour") ? n * 60 : n }
  }
  if (text === "hourly" || text === "every hour") return { kind: "hourly", minute: 0 }

  const time = parseTime(text) ?? { hour: 9, minute: 0 }

  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    if (text.includes(name)) return { kind: "weekly", weekday: dow, hour: time.hour, minute: time.minute }
  }
  if (text.includes("weekday")) return { kind: "weekday", hour: time.hour, minute: time.minute }
  if (text.includes("daily") || text.includes("every day") || text.includes("each day")) {
    return { kind: "daily", hour: time.hour, minute: time.minute }
  }
  // A bare time ("at 7am") defaults to daily.
  if (/\d/.test(text) && (text.includes("am") || text.includes("pm") || text.includes(":"))) {
    return { kind: "daily", hour: time.hour, minute: time.minute }
  }
  return null
}

function pad(n: number): string {
  return n.toString().padStart(2, "0")
}

export function describeSpec(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case "interval":
      return `every ${spec.intervalMinutes} min`
    case "hourly":
      return "hourly"
    case "daily":
      return `daily at ${pad(spec.hour ?? 9)}:${pad(spec.minute ?? 0)}`
    case "weekday":
      return `weekdays at ${pad(spec.hour ?? 9)}:${pad(spec.minute ?? 0)}`
    case "weekly": {
      const day = Object.entries(WEEKDAYS).find(([, d]) => d === spec.weekday)?.[0] ?? "monday"
      return `every ${day} at ${pad(spec.hour ?? 9)}:${pad(spec.minute ?? 0)}`
    }
  }
}

/** The next run time (ms epoch) strictly after `fromMs`. */
export function nextRunMs(spec: ScheduleSpec, fromMs: number): number {
  const from = new Date(fromMs)
  if (spec.kind === "interval") return fromMs + (spec.intervalMinutes ?? 60) * 60_000
  if (spec.kind === "hourly") {
    const next = new Date(from)
    next.setMinutes(spec.minute ?? 0, 0, 0)
    if (next.getTime() <= fromMs) next.setHours(next.getHours() + 1)
    return next.getTime()
  }
  const hour = spec.hour ?? 9
  const minute = spec.minute ?? 0
  const candidate = new Date(from)
  candidate.setHours(hour, minute, 0, 0)
  if (candidate.getTime() <= fromMs) candidate.setDate(candidate.getDate() + 1)
  // advance to a matching day
  for (let i = 0; i < 8; i += 1) {
    const dow = candidate.getDay()
    const ok =
      spec.kind === "daily" ||
      (spec.kind === "weekday" && dow >= 1 && dow <= 5) ||
      (spec.kind === "weekly" && dow === spec.weekday)
    if (ok) return candidate.getTime()
    candidate.setDate(candidate.getDate() + 1)
    candidate.setHours(hour, minute, 0, 0)
  }
  return candidate.getTime()
}

export interface ScheduledTask {
  id: string
  command: string
  spec: ScheduleSpec
  description: string
  createdAt: string
  lastRunMs?: number
  /** Opt-in: POSTed a job-complete event when `schedule run-due --execute` runs this task. */
  notifyWebhookUrl?: string
}

/** Is the task due to run at `nowMs` given its last run? */
export function isDue(task: ScheduledTask, nowMs: number): boolean {
  const since = task.lastRunMs ?? new Date(task.createdAt).getTime()
  return nextRunMs(task.spec, since) <= nowMs
}

// ---- notify bridge (opt-in job-complete webhook ping, Phase 10.3) ----
import { redactSessionText } from "../session/session.ts"

export interface ScheduleNotifyPayload {
  event: "schedule.completed"
  taskId: string
  command: string
  ok: boolean
  durationMs: number
  output: string
}

/** Build the webhook POST body for a completed scheduled run. Both `command`
 * (a stored schedule can itself contain a pasted credential, e.g. in a flag
 * or URL) and `output` are redacted the same way session transcripts are —
 * a notify payload leaves the local machine, so it's just as much an
 * exfiltration risk as a saved/shared session (Codex review, PR #1207). */
export function buildScheduleNotifyPayload(
  task: ScheduledTask,
  result: { ok: boolean; durationMs: number; output: string },
): ScheduleNotifyPayload {
  return {
    event: "schedule.completed",
    taskId: task.id,
    command: redactSessionText(task.command),
    ok: result.ok,
    durationMs: result.durationMs,
    output: redactSessionText(result.output),
  }
}

// ---- persistence (thin fs wrappers; ~/.config/secapi/schedules.json, 0600) ----
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export function schedulesPath(env: NodeJS.ProcessEnv, home: string): string {
  return env.SECAPI_SCHEDULE_FILE?.trim() || join(home, ".config", "secapi", "schedules.json")
}

export function parseSchedules(raw: string | null): ScheduledTask[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : []
    return tasks.filter(
      (t: unknown): t is ScheduledTask =>
        t !== null && typeof t === "object" && typeof (t as ScheduledTask).id === "string" && typeof (t as ScheduledTask).command === "string",
    )
  } catch {
    return []
  }
}

export function loadSchedules(env: NodeJS.ProcessEnv, home: string): ScheduledTask[] {
  const path = schedulesPath(env, home)
  return existsSync(path) ? parseSchedules(readFileSync(path, "utf8")) : []
}

export function saveSchedules(env: NodeJS.ProcessEnv, home: string, tasks: ScheduledTask[]): string {
  const path = schedulesPath(env, home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ object: "secapi_cli_schedules", tasks }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}
