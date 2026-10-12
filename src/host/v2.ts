/**
 * OpenCode V2 host adapter.
 *
 * The only module (besides the plugin entry) that calls the V2 plugin context.
 * Core modules depend on the small interfaces implemented here, so the rest of
 * Zenox stays API-agnostic and testable with in-memory fakes.
 */

import type { Plugin, Model } from "@opencode/plugin"
import type { BackgroundSessionHost, SessionMessageText } from "../background"
import type { PermissionRule } from "../agents/types"
import { NO_RECURSION_PERMISSIONS } from "../agents/tool-policy"

export type PluginContext = Plugin.Context

/** Permissions applied to every background child session (recursion guard). */
export const BACKGROUND_CHILD_PERMISSIONS: readonly PermissionRule[] = NO_RECURSION_PERMISSIONS

const WAIT_RETRY_DELAY_MS = 1_000
const MAX_WAIT_RETRY_DELAY_MS = 30_000

/** Metadata stamped on background child sessions so they are identifiable. */
export const BACKGROUND_SESSION_METADATA = { zenox: "background" } as const

/** Minimal message shape read from `session.context`. */
interface ContextMessage {
  readonly type: string
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
}

export function toMessageTexts(messages: readonly ContextMessage[]): SessionMessageText[] {
  return messages.map((message) => {
    if (message.type !== "assistant") return { role: "other", texts: [] }
    const texts = (message.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
    return { role: "assistant", texts }
  })
}

export function createBackgroundSessionHost(
  session: Pick<PluginContext["session"], "create" | "prompt" | "interrupt" | "context" | "wait">,
  options: { retryDelayMs?: number } = {}
): BackgroundSessionHost {
  const retryDelayMs = options.retryDelayMs ?? WAIT_RETRY_DELAY_MS
  return {
    async createChildSession({ parentSessionID, agent, title }) {
      const created = await session.create({
        parentID: parentSessionID,
        title,
        ...(agent ? { agent } : {}),
        permissions: [...BACKGROUND_CHILD_PERMISSIONS],
        metadata: { ...BACKGROUND_SESSION_METADATA },
      })
      if (!created?.id) throw new Error("Failed to create background session")
      return created.id
    },
    async prompt(sessionID, text) {
      await session.prompt({ sessionID, text })
    },
    async waitForCompletion(sessionID, isActive) {
      // session.wait resolves when the session is idle — possibly before the
      // admitted prompt has started. Only treat the child as finished once it
      // has produced an assistant message. Transient errors are retried; the
      // manager's task timeout is the only path that fails a stuck task.
      let delay = retryDelayMs
      while (isActive()) {
        try {
          await session.wait({ sessionID })
          if (!isActive()) return
          const messages = await session.context({ sessionID })
          if (toMessageTexts(messages).some((m) => m.role === "assistant")) return
        } catch {
          // fall through to backoff
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay)
          ;(timer as { unref?: () => void }).unref?.()
        })
        delay = Math.min(delay * 2, MAX_WAIT_RETRY_DELAY_MS)
      }
    },
    async interrupt(sessionID) {
      await session.interrupt({ sessionID })
    },
    async readMessages(sessionID) {
      const messages = await session.context({ sessionID })
      return toMessageTexts(messages)
    },
  }
}

/**
 * Parse `provider/model[#variant]` into a V2 model reference. The model ID may
 * itself contain slashes (e.g. `openrouter/anthropic/claude`).
 */
export function parseModelRef(value: string): Model.Ref | undefined {
  const [modelPart, variant] = value.split("#", 2)
  const slash = modelPart.indexOf("/")
  if (slash <= 0 || slash === modelPart.length - 1) return undefined
  const providerID = modelPart.slice(0, slash) as Model.Ref["providerID"]
  const id = modelPart.slice(slash + 1) as Model.Ref["id"]
  return variant
    ? { providerID, id, variant: variant as NonNullable<Model.Ref["variant"]> }
    : { providerID, id }
}
