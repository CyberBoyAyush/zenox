/**
 * Session tools (back from Zenox 1.x, now on the V2 session API):
 * - session_search: find past sessions of this project by title/content
 * - session_read: read the conversation text of one session
 */

import { z } from "zod"
import type { ToolEditor } from "@opencode/plugin/promise/tool"
import { addZodTool } from "../../shared/tool"

/** Minimal shapes read from `session.list` / `session.context`. */
export interface SessionSummary {
  readonly id: string
  readonly parentID?: string
  readonly title?: string
  readonly agent?: string
  readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string }
  readonly time: { readonly created: number; readonly updated: number }
}

interface ContextMessage {
  readonly type: string
  readonly text?: string
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string; readonly name?: string }>
}

export interface SessionApi {
  list(input: {
    search?: string
    limit?: number
    order?: "asc" | "desc"
    directory?: string
  }): Promise<{ readonly data: ReadonlyArray<SessionSummary> }>
  context(input: { sessionID: string }): Promise<ReadonlyArray<ContextMessage>>
  get(input: { sessionID: string }): Promise<{ readonly location?: { readonly directory: string } }>
}

const sameDirectory = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "")

const MAX_MESSAGE_CHARS = 2_000

const formatTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16)

export async function searchSessions(
  api: SessionApi,
  directory: string,
  input: { query?: string; limit?: number },
  currentSessionID?: string
): Promise<string> {
  const query = input.query?.trim()
  const { data } = await api.list({
    directory,
    order: "desc",
    limit: input.limit ?? 10,
    ...(query ? { search: query } : {}),
  })
  const sessions = data.filter((s) => s.id !== currentSessionID)
  if (sessions.length === 0) {
    return query ? `No sessions found matching "${query}".` : "No other sessions found in this project."
  }
  const lines = sessions.map((s) => {
    const model = s.model ? `, ${s.model.providerID}/${s.model.id}` : ""
    const child = s.parentID ? ", subagent" : ""
    return `- ${s.id} — ${s.title ?? "(untitled)"} (updated ${formatTime(s.time.updated)}${s.agent ? `, ${s.agent}` : ""}${model}${child})`
  })
  const header = query ? `Sessions matching "${query}":` : "Recent sessions:"
  return `${header}\n${lines.join("\n")}\n\nUse session_read(session_id) to read one.`
}

function messageText(message: ContextMessage): string {
  if (message.type === "user") return message.text ?? ""
  if (message.type !== "assistant") return ""
  const parts = (message.content ?? []).flatMap((part) => {
    if (part.type === "text" && part.text) return [part.text]
    if (part.type === "tool" && part.name) return [`[tool: ${part.name}]`]
    return []
  })
  return parts.join("\n")
}

export async function readSession(
  api: SessionApi,
  directory: string,
  input: { session_id: string; limit?: number }
): Promise<string> {
  let messages: ReadonlyArray<ContextMessage>
  try {
    // Same boundary as session_search: only sessions of this project, fail closed.
    const info = await api.get({ sessionID: input.session_id })
    if (!info.location?.directory || !sameDirectory(info.location.directory, directory)) {
      return `Session ${input.session_id} is not part of this project.`
    }
    messages = await api.context({ sessionID: input.session_id })
  } catch (err) {
    return `Could not read session ${input.session_id}: ${err instanceof Error ? err.message : String(err)}`
  }
  const rendered = messages
    .filter((m) => m.type === "user" || m.type === "assistant")
    .map((m) => {
      const text = messageText(m).trim()
      const clipped = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}… [truncated]` : text
      return clipped ? `### ${m.type}\n${clipped}` : ""
    })
    .filter(Boolean)
  if (rendered.length === 0) return `Session ${input.session_id} has no messages.`
  const limit = input.limit ?? 20
  const shown = rendered.slice(-limit)
  const skipped = rendered.length - shown.length
  return `${skipped > 0 ? `(${skipped} earlier message(s) omitted)\n\n` : ""}${shown.join("\n\n")}`
}

export function addSessionTools(editor: ToolEditor, api: SessionApi, directory: string): void {
  addZodTool(editor, {
    name: "session_search",
    description: `Search past OpenCode sessions in this project by title and content.
Use it to recall earlier work, decisions, or conversations. Omit query to list the most recent sessions.`,
    schema: z.object({
      query: z.string().optional().describe("Text to search for. Omit to list recent sessions."),
      limit: z.number().int().min(1).max(50).optional().describe("Max sessions to return (default 10)"),
    }),
    execute: (input, context) => searchSessions(api, directory, input, context.sessionID),
  })

  addZodTool(editor, {
    name: "session_read",
    description: `Read the conversation (user and assistant text) of a past session found with session_search.`,
    schema: z.object({
      session_id: z.string().describe("Session ID from session_search"),
      limit: z.number().int().min(1).max(200).optional().describe("Max recent messages to return (default 20)"),
    }),
    execute: (input) => readSession(api, directory, input),
  })
}
