/**
 * Todo Continuation Enforcer Hook
 *
 * Automatically reminds the agent to continue working when:
 * - Session goes idle (session.idle event)
 * - There are incomplete todos (pending or in_progress)
 *
 * Features:
 * - Skips child sessions (background tasks)
 * - Cooldown to prevent spam (10 seconds between reminders)
 * - Shows toast notification when enforcing
 * - Mode-aware: preserves Plan/Build agent context
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type { Event, Todo, Session } from "@opencode-ai/sdk"
import { getSessionContext } from "../../orchestration/session-agent-tracker"

const COOLDOWN_MS = 10_000 // 10 seconds between reminders
const TOAST_DURATION = 3000

// Agents to skip (Plan mode should not auto-continue with file edits)
const SKIP_AGENTS = ["plan"]

const CONTINUATION_PROMPT = `[TODO CONTINUATION REMINDER]

You have incomplete tasks in your todo list. Continue working on them.

Rules:
- Proceed without asking for permission
- Mark each task complete when finished
- Update todo status as you work
- Do not stop until all tasks are done or blocked`

interface SessionState {
  lastEnforcedAt: number
  enforceCount: number
}

// Type for message info from the API (agent field is what we need)
interface MessageInfo {
  agent?: string
  role?: string
}

export function createTodoEnforcerHook(ctx: PluginInput) {
  const sessionStates = new Map<string, SessionState>()

  const cleanupOldStates = () => {
    const now = Date.now()
    const maxAge = 30 * 60 * 1000 // 30 minutes
    for (const [sessionID, state] of sessionStates) {
      if (now - state.lastEnforcedAt > maxAge) {
        sessionStates.delete(sessionID)
      }
    }
  }

  return {
    event: async ({ event }: { event: Event }) => {
      if (event.type !== "session.idle") return

      const props = event.properties as { sessionID?: string }
      const sessionID = props?.sessionID
      if (!sessionID) return

      // Get or create session state
      let state = sessionStates.get(sessionID)
      if (!state) {
        state = { lastEnforcedAt: 0, enforceCount: 0 }
        sessionStates.set(sessionID, state)
      }

      // Check cooldown
      const now = Date.now()
      if (now - state.lastEnforcedAt < COOLDOWN_MS) {
        return
      }

      // Skip child sessions and detect current agent
      let agent: string | undefined
      try {
        const sessionResult = await ctx.client.session.get({
          path: { id: sessionID },
        })
        const session = sessionResult.data as Session | undefined
        if (session?.parentID) {
          return // Child session, skip
        }

        // Get agent from last message (API returns { info: { agent, role, ... }, parts: [...] })
        const msgs = await ctx.client.session.messages({
          path: { id: sessionID },
          query: { limit: 5 },
        })
        const messages = (msgs.data ?? []) as Array<{ info?: MessageInfo }>
        for (let i = messages.length - 1; i >= 0; i--) {
          const info = messages[i]?.info
          if (info?.agent) {
            agent = info.agent
            break
          }
        }
      } catch {
        return // Session not found or error, skip
      }

      // Skip if agent is in skip list (e.g., plan mode)
      if (agent && SKIP_AGENTS.includes(agent)) {
        return
      }

      // Get todos for this session
      let todos: Todo[] = []
      try {
        const todosResult = await ctx.client.session.todo({
          path: { id: sessionID },
        })
        todos = (todosResult.data ?? []) as Todo[]
      } catch {
        return // Failed to get todos, skip
      }

      if (todos.length === 0) {
        return // No todos, nothing to enforce
      }

      // Filter incomplete todos
      const incomplete = todos.filter(
        (t) => t.status === "pending" || t.status === "in_progress"
      )

      if (incomplete.length === 0) {
        return // All todos complete
      }

      // Update state
      state.lastEnforcedAt = now
      state.enforceCount++

      // Build todo list for prompt
      const todoList = incomplete
        .map((t) => {
          const priority = t.priority === "high" ? "!" : ""
          return `- [${t.status}]${priority} ${t.content}`
        })
        .join("\n")

      const completedCount = todos.length - incomplete.length
      const statusLine = `[Status: ${completedCount}/${todos.length} completed, ${incomplete.length} remaining]`

      const prompt = `${CONTINUATION_PROMPT}

Current incomplete tasks:
${todoList}

${statusLine}`

      // Get model context from session tracker
      const sessionContext = getSessionContext(sessionID)
      const model = sessionContext?.model

      // Send continuation prompt with agent and model preservation
      const sendPrompt = async (omitContext = false) => {
        await ctx.client.session.prompt({
          path: { id: sessionID },
          body: {
            noReply: false,
            ...(omitContext || !agent ? {} : { agent }),
            ...(omitContext || !model ? {} : { model }),
            parts: [{ type: "text", text: prompt }],
          },
        })
      }

      try {
        await sendPrompt()
      } catch (err) {
        // Retry without agent/model if we hit undefined error
        const errorMsg = err instanceof Error ? err.message : String(err)
        if (errorMsg.includes("agent") || errorMsg.includes("model") || errorMsg.includes("undefined")) {
          try {
            await sendPrompt(true)
          } catch {
            return
          }
        } else {
          return
        }
      }

      // Show toast notification
      await ctx.client.tui
        .showToast({
          body: {
            title: "📋 Todo Reminder",
            message: `${incomplete.length} task(s) remaining`,
            variant: "info",
            duration: TOAST_DURATION,
          },
        })
        .catch(() => {})

      // Periodic cleanup
      if (sessionStates.size > 50) {
        cleanupOldStates()
      }
    },
  }
}

export type { SessionState }
