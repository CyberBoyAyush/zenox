/**
 * Zenox setup for the OpenCode V2 plugin API.
 *
 * Wires the API-agnostic core (agents, prompts, keywords, background manager,
 * guidelines) onto the V2 plugin context.
 */

import type { Plugin } from "@opencode/plugin"
import { resolveAgents } from "./agents"
import { loadPluginConfig, type ZenoxConfig } from "./config"
import { createBuiltinMcps } from "./mcp"
import { getOrchestrationPrompt } from "./orchestration/prompt"
import { BackgroundManager, addBackgroundTools, type CompletionNotification } from "./background"
import { TaskToastManager } from "./features/task-toast"
import { createKeywordDetectorHook } from "./hooks"
import { addProjectGuidelinesTool } from "./tools/project-guidelines"
import { loadBundledSkills } from "./skills"
import { ZENOX_RPC, withTimeout, type ToastSink } from "./shared"
import { createBackgroundSessionHost, parseModelRef } from "./host/v2"

/** The slice of the V2 plugin context Zenox uses (keeps test fakes honest). */
export type ZenoxContext = Pick<
  Plugin.Context,
  "location" | "agent" | "mcp" | "skill" | "tool" | "session" | "event" | "rpc"
>

/** Bound on delivering a completion notification so a hung call cannot wedge a claim. */
const DELIVERY_TIMEOUT_MS = 30_000
const EVENT_RETRY_DELAY_MS = 2_000
const DELIVERY_RETRY_DELAY_MS = 15_000
const MAX_DELIVERY_RETRIES = 3

/** Agents that receive the orchestration prompt. */
const ORCHESTRATED_AGENTS = new Set(["build", "plan"])

/** Prefix of every notice Zenox injects into a session. */
const SYSTEM_REMINDER_PREFIX = "<system-reminder>"

export interface ZenoxSetupOptions {
  /** Override config loading (tests). */
  config?: ZenoxConfig
}

export async function setupZenox(
  ctx: ZenoxContext,
  options: ZenoxSetupOptions = {}
): Promise<() => Promise<void>> {
  const directory = ctx.location.directory
  const config = options.config ?? loadPluginConfig(directory)
  const disabledAgents = new Set<string>(config.disabled_agents ?? [])
  const disabledSkills = new Set<string>(config.disabled_skills ?? [])

  // Toasts travel to the ./tui plugin over Zenox's RPC event channel.
  let toast: ToastSink = () => {}
  try {
    const rpc = await ctx.rpc.register(ZENOX_RPC, {})
    toast = (payload) => {
      rpc.events.emit("toast", payload).catch(() => {})
    }
  } catch (err) {
    console.warn("[zenox] toast channel unavailable:", err instanceof Error ? err.message : err)
  }

  // --- Agents -------------------------------------------------------------
  const agents = resolveAgents(config)
  await ctx.agent.transform((editor) => {
    // OpenCode seeds config-defined agents with the user's global permission
    // rules; agents created by a plugin start empty. Inherit a snapshot of a
    // built-in agent's rules (global rules + safety defaults) so user
    // restrictions still apply, then append Zenox's own restrictions last.
    const inherited = [
      ...(editor.get("build")?.permissions ?? editor.get("general")?.permissions ?? []),
    ].map((rule) => ({ ...rule }))

    for (const [name, definition] of agents) {
      const model = parseModelRef(definition.model)
      const exists = editor.get(name) !== undefined
      // update() creates the agent when it does not exist yet.
      editor.update(name, (agent) => {
        if (!exists) agent.permissions = inherited.map((rule) => ({ ...rule }))
        agent.description = definition.description
        agent.mode = definition.mode
        agent.system = definition.system
        agent.color = definition.color
        agent.hidden = false
        if (model) agent.model = { ...model }
        // Appended after existing rules: Zenox's restrictions win (last match wins).
        agent.permissions = [...(agent.permissions ?? []), ...definition.permissions]
      })
    }
  })

  // --- MCP servers --------------------------------------------------------
  const mcps = createBuiltinMcps(config.disabled_mcps ?? [])
  await ctx.mcp.transform((editor) => {
    for (const [name, server] of Object.entries(mcps)) {
      editor.set(name, server)
    }
  })

  // --- Bundled skills (in memory; never overrides a same-named user skill) --
  const skills = loadBundledSkills([...disabledSkills])
  if (skills.length > 0) {
    await ctx.skill.transform((editor) => {
      for (const skill of skills) {
        if (editor.get(skill.id)) continue
        editor.add({
          id: skill.id as Parameters<typeof editor.add>[0]["id"],
          name: skill.name as Parameters<typeof editor.add>[0]["name"],
          path: skill.path as Parameters<typeof editor.add>[0]["path"],
          content: skill.content,
          ...(skill.description ? { description: skill.description } : {}),
        })
      }
    })
  }

  // --- Background tasks ---------------------------------------------------
  const backgroundManager = new BackgroundManager(createBackgroundSessionHost(ctx.session))
  backgroundManager.setToastManager(new TaskToastManager(toast))
  backgroundManager.setLimits(
    config.background
      ? {
          maxConcurrent: config.background.max_concurrent,
          maxPerSession: config.background.max_per_session,
          taskTimeoutMs: config.background.timeout_minutes
            ? config.background.timeout_minutes * 60_000
            : undefined,
        }
      : undefined
  )

  // Delivered as a prompt (like V1's session.prompt): synthetic input is not
  // reliably included in the model prompt for plugins (anomalyco/opencode#44788).
  // Partial notices only append (resume: false, V1 noReply); all-complete
  // notices resume the parent so it synthesizes the results.
  const deliverNotification = async (notification: CompletionNotification): Promise<void> => {
    const send = async (): Promise<boolean> => {
      try {
        await ctx.session.prompt({
          sessionID: notification.parentSessionID,
          text: notification.message,
          resume: notification.allComplete,
        })
        return true
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        console.error(
          `[zenox] could not deliver background completion to ${notification.parentSessionID}: ${errorMsg}`
        )
        return false
      }
    }

    // Confirm the claim only once delivered; release it on failure or hang so
    // the parent's next idle retries.
    const delivered = await withTimeout(send(), DELIVERY_TIMEOUT_MS, false)
    if (delivered && notification.allComplete) {
      backgroundManager.markNotified(notification.completedTasks)
      retryAttempts.delete(notification.parentSessionID)
    } else if (!delivered) {
      backgroundManager.releaseClaim(notification.completedTasks)
      if (notification.allComplete) scheduleRetry(notification.parentSessionID)
    }
  }

  // Retry an undelivered all-complete batch on a timer as well as on the
  // parent's next idle, since plugin event delivery may be unavailable.
  const retryAttempts = new Map<string, number>()
  const retryTimers = new Set<ReturnType<typeof setTimeout>>()
  const scheduleRetry = (parentSessionID: string): void => {
    const attempt = (retryAttempts.get(parentSessionID) ?? 0) + 1
    if (attempt > MAX_DELIVERY_RETRIES) {
      // Give up on timers; the parent's next idle still retries.
      retryAttempts.delete(parentSessionID)
      return
    }
    retryAttempts.set(parentSessionID, attempt)
    const timer = setTimeout(() => {
      retryTimers.delete(timer)
      const pending = backgroundManager.getCompletionStatusForSession(parentSessionID)
      if (pending?.allComplete) deliverNotification(pending).catch(() => {})
    }, DELIVERY_RETRY_DELAY_MS * attempt)
    ;(timer as { unref?: () => void }).unref?.()
    retryTimers.add(timer)
  }

  // A failed launch never produces session.idle, so the manager pushes it here.
  backgroundManager.setCompletionNotifier((notification) => {
    deliverNotification(notification).catch(() => {})
  })

  // --- Tools --------------------------------------------------------------
  await ctx.tool.transform((editor) => {
    addBackgroundTools(editor, backgroundManager)
    addProjectGuidelinesTool(editor, directory)
  })

  // --- Session hooks ------------------------------------------------------
  const detectKeywords = createKeywordDetectorHook(toast)
  await ctx.session.hook("prompt", (event) => {
    // Zenox's own injected notices and delegated background prompts are not user input.
    if (event.prompt.text.startsWith(SYSTEM_REMINDER_PREFIX)) return
    if (backgroundManager.isBackgroundSession(event.sessionID)) return
    detectKeywords(event)
  })

  await ctx.session.hook("context", (event) => {
    if (!ORCHESTRATED_AGENTS.has(event.agent)) return
    const prompt = getOrchestrationPrompt(event.agent, disabledAgents, disabledSkills)
    if (prompt) event.system.push({ type: "text", text: prompt })
  })

  // --- Events -------------------------------------------------------------
  const handleIdle = async (sessionID: string): Promise<void> => {
    // A background child finished: notify its parent.
    const notification = backgroundManager.handleSessionIdle(sessionID)
    if (notification) {
      await deliverNotification(notification)
      return
    }

    // This session may own an all-complete batch whose delivery failed earlier.
    const pending = backgroundManager.getCompletionStatusForSession(sessionID)
    if (pending?.allComplete) {
      await deliverNotification(pending)
    }
  }

  // Child completion detected by waiting on the child session.
  backgroundManager.setChildIdleListener((sessionID) => {
    handleIdle(sessionID).catch(() => {})
  })

  const controller = new AbortController()
  const consumeEvents = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.idle") {
            handleIdle(event.data.sessionID).catch(() => {})
          } else if (event.type === "session.deleted") {
            // Abort its running children; nobody is left to read them.
            backgroundManager.detachParentSession(event.data.sessionID)
            retryAttempts.delete(event.data.sessionID)
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return
        console.warn("[zenox] event stream error, reconnecting:", err instanceof Error ? err.message : err)
      }
      if (controller.signal.aborted) return
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          controller.signal.removeEventListener("abort", onAbort)
          resolve()
        }, EVENT_RETRY_DELAY_MS)
        controller.signal.addEventListener("abort", onAbort, { once: true })
      })
    }
  }
  void consumeEvents()

  return async () => {
    controller.abort()
    for (const timer of retryTimers) clearTimeout(timer)
    retryTimers.clear()
    backgroundManager.dispose()
  }
}
