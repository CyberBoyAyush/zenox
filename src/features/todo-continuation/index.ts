/**
 * Todo continuation: when a primary session is about to go idle with unfinished
 * todos (OpenCode's opt-in `todowrite` tool), nudge the agent to keep going.
 *
 * Runs from the V2 `experimental.idle` session hook. Input admitted there runs
 * in the same execution, so the agent continues instead of stopping. Guarded
 * by a per-session continuation cap and a stall check (unchanged todos).
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export interface Todo {
  content: string
  status: TodoStatus
}

const STATUSES = new Set<string>(["pending", "in_progress", "completed", "cancelled"])

/** Prefix of the injected reminder; also used to recognise it in the transcript. */
export const TODO_CONTINUATION_MARKER = "[TODO CONTINUATION]"

export const DEFAULT_MAX_CONTINUATIONS = 10
/** Consecutive continuations with an unchanged todo list before giving up. */
export const MAX_STALLS = 2

/** Minimal message shape read from `session.context`. */
export interface TranscriptMessage {
  readonly type: string
  readonly text?: string
  readonly content?: ReadonlyArray<{
    readonly type: string
    readonly text?: string
    readonly name?: string
    readonly state?: { readonly status?: string; readonly input?: unknown }
  }>
}

/**
 * The current todo list: the input of the latest completed `todowrite` call
 * (the tool keeps no server state). Malformed entries are dropped.
 */
export function readTodos(messages: readonly TranscriptMessage[]): Todo[] {
  let input: unknown
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content ?? []) {
      if (part.type === "tool" && part.name === "todowrite" && part.state?.status === "completed") {
        input = part.state.input
      }
    }
  }
  const todos = (input as { todos?: unknown } | undefined)?.todos
  if (!Array.isArray(todos)) return []
  return todos.flatMap((item: unknown): Todo[] => {
    if (typeof item !== "object" || item === null) return []
    const { content, status } = item as { content?: unknown; status?: unknown }
    if (typeof content !== "string" || content.length === 0) return []
    return [{ content, status: typeof status === "string" && STATUSES.has(status) ? (status as TodoStatus) : "pending" }]
  })
}

export const isUnfinished = (todo: Todo) => todo.status === "pending" || todo.status === "in_progress"

/** Text of the last assistant message (used to spot a question to the user). */
export function lastAssistantText(messages: readonly TranscriptMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.type !== "assistant") continue
    return (message.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim()
  }
  return ""
}

export function buildContinuationReminder(todos: readonly Todo[], attempt: number, max: number): string {
  const open = todos.filter(isUnfinished)
  const list = open.map((todo) => `- [${todo.status}] ${todo.content}`).join("\n")
  return `<system-reminder>
${TODO_CONTINUATION_MARKER} ${open.length} todo(s) are still unfinished (continuation ${attempt}/${max}):
${list}

Continue with the next unfinished todo now. Update the todo list with todowrite as you finish each one.
If a todo is no longer needed, mark it cancelled. If you are blocked or need the user's input, explain why and mark the blocked todo cancelled instead of stopping silently.
</system-reminder>`
}

export interface ContinuationDecision {
  continue: boolean
  /** Why the session was left alone (for tests and logs). */
  reason?: "no-todos" | "done" | "asking-user" | "limit" | "stalled"
  reminder?: string
  open?: number
  /** Records the continuation; call only once the reminder was delivered. */
  commit?: () => void
}

interface SessionState {
  count: number
  stalls: number
  lastSnapshot?: string
}

/** Per-session bookkeeping for continuation limits. Pure apart from its own map. */
export class TodoContinuationTracker {
  private sessions = new Map<string, SessionState>()

  constructor(private readonly maxContinuations: number = DEFAULT_MAX_CONTINUATIONS) {}

  /** A real user prompt starts a fresh budget. */
  reset(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  forget(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  decide(sessionID: string, messages: readonly TranscriptMessage[]): ContinuationDecision {
    const todos = readTodos(messages)
    if (todos.length === 0) return { continue: false, reason: "no-todos" }
    const open = todos.filter(isUnfinished)
    if (open.length === 0) {
      this.sessions.delete(sessionID)
      return { continue: false, reason: "done" }
    }
    // The agent ended its turn on a question: let the user answer it.
    if (lastAssistantText(messages).endsWith("?")) return { continue: false, reason: "asking-user", open: open.length }

    const state = this.sessions.get(sessionID) ?? { count: 0, stalls: 0 }
    if (state.count >= this.maxContinuations) return { continue: false, reason: "limit", open: open.length }

    const snapshot = JSON.stringify(todos)
    const stalls = state.lastSnapshot === snapshot ? state.stalls + 1 : 0
    if (stalls >= MAX_STALLS) {
      this.sessions.set(sessionID, { ...state, stalls })
      return { continue: false, reason: "stalled", open: open.length }
    }

    const count = state.count + 1
    return {
      continue: true,
      reminder: buildContinuationReminder(todos, count, this.maxContinuations),
      open: open.length,
      commit: () => this.sessions.set(sessionID, { count, stalls, lastSnapshot: snapshot }),
    }
  }
}
