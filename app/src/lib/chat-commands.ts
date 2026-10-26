// Chat commands: a message that starts with "/" runs in the app and is never sent to the model.
// The popup, /help and the parser all read this one list. Only commands that change nothing but
// the page are here; ones that change powers or settings (model, instance, pipelines, memory,
// compaction) wait for the harness gate (harness architecture 10, item 4).
// Only what the person types or dictates into the chat box is parsed, and only when they press
// Enter. The Talk to Dave voice bridge sends straight to the gateway, so it never runs a command.

export type ChatCommandName = "help" | "new" | "stop" | "context"

export interface ChatCommand {
  name: ChatCommandName
  args?: string          // shown after the name in the popup and /help; without it the command takes no text
  description: string
}

export const CHAT_COMMANDS: ChatCommand[] = [
  { name: "help", description: "List the chat commands" },
  { name: "new", args: "[title]", description: "Start a new chat, with a name if you give one" },
  { name: "stop", description: "Stop the reply that's being written" },
  { name: "context", description: "How full the chat is, and which model and chat this is" },
]

export type ParsedInput =
  | { kind: "message"; text: string }
  | { kind: "command"; command: ChatCommand; arg: string }
  | { kind: "unknown"; name: string }

/**
 * What a typed message is. A command is "/name" alone, or "/name text" on one line for a command
 * that takes text. Anything longer ("/help me write a regex", a pasted block that starts with
 * "/stop") is an ordinary message, so nothing typed is lost. "//text" sends "/text" as a message.
 */
export function parseInput(text: string): ParsedInput {
  if (text.startsWith("//")) return { kind: "message", text: text.slice(1) }
  const match = /^\/([a-z]+)(?:[ \t]+(.*))?$/i.exec(text)
  if (!match) return { kind: "message", text }
  const name = match[1]!.toLowerCase()
  const arg = (match[2] ?? "").trim()
  const command = CHAT_COMMANDS.find(c => c.name === name)
  if (!command) return { kind: "unknown", name }
  if (arg && !command.args) return { kind: "message", text }
  return { kind: "command", command, arg }
}

/** The commands to offer while the person is typing a name ("/", "/ne"); none once they type a space. */
export function suggestCommands(draft: string): ChatCommand[] {
  const match = /^\/([a-z]*)$/i.exec(draft)
  if (!match) return []
  const typed = match[1]!.toLowerCase()
  return CHAT_COMMANDS.filter(c => c.name.startsWith(typed))
}

/** The text a picked command fills the box with: "/stop", or "/new " ready for its title. */
export function commandStub(command: ChatCommand): string {
  return `/${command.name}${command.args ? " " : ""}`
}

export function helpText(): string {
  const lines = CHAT_COMMANDS.map(c => `/${c.name}${c.args ? ` ${c.args}` : ""}  ${c.description}`)
  return [...lines, "Start a message with // to send it with a slash at the front."].join("\n")
}
