// Remote control bridge (opt-in, "the Grok bold move") — drive read-only
// secapi commands from Telegram while a long-running task is elsewhere.
// Long-polls Telegram's getUpdates (zero new runtime dep — plain fetch, no
// public webhook endpoint to expose/secure). Security posture, by design:
//   - the bot token is read from an env var by NAME, never accepted as a
//     literal argv value (same discipline as API key handling elsewhere);
//   - only the operator's own allow-listed chat id is ever acted on — every
//     other chat is silently ignored, so this is not an open remote shell;
//   - mutating commands are refused (fail CLOSED: an unrecognized command is
//     treated as mutating) — the bridge can only ever be a read-only remote
//     viewer, never a way to spend money or change state from a phone.
// Pure and fully injectable so it's unit-testable without a real network call.

export interface TelegramMessage {
  message_id: number
  chat: { id: number }
  text?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

export interface BridgeCommandResult {
  stdout: string
  stderr: string
  code: number
}

export interface BridgeDeps {
  fetchUpdates: (offset: number | undefined) => Promise<TelegramUpdate[]>
  sendMessage: (chatId: number, text: string) => Promise<void>
  runCommand: (tokens: string[]) => Promise<BridgeCommandResult>
  /** True if this command must be refused (mutating, or unrecognized — fail closed). */
  isBlocked: (tokens: string[]) => boolean
  allowedChatId: number
  writeLog: (line: string) => void
}

/** Telegram messages are capped at 4096 chars; leave room for the code-fence wrapper. */
const MAX_REPLY_BODY = 3800

export function formatReply(result: BridgeCommandResult): string {
  const body = (result.stdout.trim() || result.stderr.trim() || "(no output)").slice(0, MAX_REPLY_BODY)
  return `\`\`\`\n${body}\n\`\`\``
}

export async function processUpdate(update: TelegramUpdate, deps: BridgeDeps): Promise<void> {
  const message = update.message
  if (!message?.text) return
  if (message.chat.id !== deps.allowedChatId) {
    deps.writeLog(`ignored message from unauthorized chat ${message.chat.id}`)
    return
  }
  const text = message.text.trim()
  if (!text) return
  const tokens = text.split(/\s+/)
  if (deps.isBlocked(tokens)) {
    await deps.sendMessage(message.chat.id, "⚠ That command is not allowed via the remote bridge (mutating or unrecognized). Run it from a real terminal.")
    return
  }
  const result = await deps.runCommand(tokens)
  await deps.sendMessage(message.chat.id, formatReply(result))
}

/** Process one batch of updates; returns the next `offset` to poll from. */
export async function pollOnce(offset: number | undefined, deps: BridgeDeps): Promise<number | undefined> {
  const updates = await deps.fetchUpdates(offset)
  let nextOffset = offset
  for (const update of updates) {
    await processUpdate(update, deps)
    nextOffset = update.update_id + 1
  }
  return nextOffset
}

export function telegramApiUrl(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken}/${method}`
}
