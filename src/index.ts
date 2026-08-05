/**
 * zenox - OpenCode Plugin for Intelligent Agent Orchestration
 *
 * This plugin provides:
 * 1. Specialized subagents: explorer, librarian, oracle, ui-planner
 * 2. Orchestration injection into Build/Plan agents for smart delegation
 * 3. Auto-loaded MCP servers: exa, grep_app, sequential-thinking
 * 4. Background task system for parallel agent execution
 * 5. Auto-update checker with startup toast notifications
 * 6. Optional configuration via zenox.json for model/MCP overrides
 */

import type { Plugin } from "@opencode-ai/plugin"
import type { AgentConfig, Event } from "@opencode-ai/sdk"
import {
  explorerAgent,
  librarianAgent,
  oracleAgent,
  uiPlannerAgent,
  inspectorAgent,
} from "./agents"
import { getOrchestrationPrompt } from "./orchestration/prompt"
import {
  setSessionContext,
  getSessionContext,
  getSessionAgent,
  clearSessionAgent,
  getOrchestrationAgentType,
} from "./orchestration/session-agent-tracker"
import { loadPluginConfig, type AgentName } from "./config"
import { createBuiltinMcps } from "./mcp"
import {
  BackgroundManager,
  createBackgroundTools,
  type CompletionNotification,
} from "./background"
import {
  createAutoUpdateHook,
  createKeywordDetectorHook,
  createTodoEnforcerHook,
} from "./hooks"
import { TaskToastManager } from "./features/task-toast"
import { syncBundledSkills, readPackageVersion } from "./skills"
import { createSessionTools } from "./tools/session"
import { createCodeIntelligenceTools } from "./tools/code-intelligence"
import { createProjectGuidelinesTools } from "./tools/project-guidelines"
import {
  resolveAgentVariant,
  applyAgentVariant,
  createFirstMessageVariantGate,
  withTimeout,
  type VariantMessage,
} from "./shared"

const ZenoxPlugin: Plugin = async (ctx) => {
  // Load user/project configuration
  const pluginConfig = loadPluginConfig(ctx.directory)
  const disabledAgents = new Set(pluginConfig.disabled_agents ?? [])
  const disabledSkills = new Set(pluginConfig.disabled_skills ?? [])
  const disabledMcps = pluginConfig.disabled_mcps ?? []

  // Initialize toast manager for background tasks
  const taskToastManager = new TaskToastManager(ctx.client)

  // Initialize background task manager with toast integration
  const backgroundManager = new BackgroundManager()
  backgroundManager.setToastManager(taskToastManager)
  backgroundManager.setLimits(
    pluginConfig.background
      ? {
          maxConcurrent: pluginConfig.background.max_concurrent,
          maxPerSession: pluginConfig.background.max_per_session,
          taskTimeoutMs: pluginConfig.background.timeout_minutes
            ? pluginConfig.background.timeout_minutes * 60_000
            : undefined,
        }
      : undefined
  )

  // Send a background-task completion/failure notification to its owning session.
  // Routes to the task's parent session (no cross-session bleed) and resolves
  // that session's live agent/model at send time (avoids stale Plan/Build).
  const sendCompletionNotification = async (notification: CompletionNotification) => {
    const targetSessionID = notification.parentSessionID
    if (!targetSessionID) {
      // Should not happen in practice, but never leave a claimed batch stuck.
      backgroundManager.releaseClaim(notification.completedTasks)
      return
    }

    const liveContext = getSessionContext(targetSessionID)
    const targetAgent = liveContext?.agent ?? notification.parentAgent
    const targetModel = liveContext?.model ?? notification.parentModel

    const send = async (omitContext = false): Promise<boolean> => {
      try {
        await ctx.client.session.prompt({
          path: { id: targetSessionID },
          body: {
            noReply: !notification.allComplete,
            ...(omitContext ? {} : { agent: targetAgent }),
            ...(omitContext ? {} : { model: targetModel }),
            parts: [{ type: "text", text: notification.message }],
          },
        })
        return true
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        if (
          !omitContext &&
          (errorMsg.includes("agent") || errorMsg.includes("model") || errorMsg.includes("undefined"))
        ) {
          return send(true)
        }
        console.error(
          `[zenox] could not deliver background completion to ${targetSessionID}: ${errorMsg}`
        )
        return false
      }
    }

    // Bound the delivery attempt: if session.prompt() hangs (network stall,
    // unresponsive server) rather than resolving or rejecting, an unbounded
    // await would leave the claim (and hasActiveBackgroundWork) stuck "on"
    // for this session forever. Racing a timeout treats a hang as a failure
    // so the claim is released and the next idle can retry. The abandoned
    // call is never awaited further here, so a very late real success is
    // simply not acted upon a second time by this call — at worst the
    // message is delivered twice (once late by the original call, once by
    // the retry), never zero times.
    const DELIVERY_TIMEOUT_MS = 30_000

    // Only confirm the claim once the agent has actually been told. If the
    // send failed, release it so the next idle re-attempts delivery (see the
    // session.idle handler below) instead of leaving it stuck "claiming".
    const delivered = await withTimeout(send(), DELIVERY_TIMEOUT_MS, false)
    if (delivered && notification.allComplete) {
      backgroundManager.markNotified(notification.completedTasks)
    } else if (!delivered) {
      backgroundManager.releaseClaim(notification.completedTasks)
    }
  }

  // A failed launch never emits session.idle, so the manager pushes its
  // notification through this callback instead.
  backgroundManager.setCompletionNotifier((notification) => {
    sendCompletionNotification(notification).catch(() => {})
  })

  const backgroundTools = createBackgroundTools(backgroundManager, ctx.client)

  // Initialize hooks
  const autoUpdateHook = createAutoUpdateHook(ctx, {
    showStartupToast: pluginConfig.auto_update?.show_startup_toast,
  })
  const keywordDetectorHook = createKeywordDetectorHook(ctx)
  const todoEnforcerHook = createTodoEnforcerHook(ctx, {
    hasActiveBackgroundWork: (sessionID) =>
      backgroundManager.hasActiveBackgroundWork(sessionID),
  })

  // Initialize session, code intelligence, and project guidelines tools
  const sessionTools = createSessionTools(ctx.client)
  const codeIntelligenceTools = createCodeIntelligenceTools(ctx.client)
  const projectGuidelinesTools = createProjectGuidelinesTools(ctx.directory)

  // Initialize variant gate for safe variant application on first message
  const firstMessageVariantGate = createFirstMessageVariantGate()

  // Sync bundled skills into the global skills dir once per process. Keeps
  // installed skills in step with the running package version (auto-update),
  // without requiring the CLI. Runs lazily on first main session.
  let skillsSynced = false
  const syncSkillsOnce = () => {
    if (skillsSynced) return
    skillsSynced = true
    try {
      syncBundledSkills({
        packageVersion: readPackageVersion(),
        disabledSkills: pluginConfig.disabled_skills,
      })
    } catch {
      // Non-fatal: never block startup on skill sync.
    }
  }

  // Helper to apply model override from config
  const applyModelOverride = (
    agentName: AgentName,
    baseAgent: AgentConfig
  ): AgentConfig => {
    const override = pluginConfig.agents?.[agentName]
    if (override?.model) {
      return { ...baseAgent, model: override.model }
    }
    return baseAgent
  }

  return {
    // Release in-memory state on plugin teardown (prevents leaks across reloads)
    dispose: async () => {
      backgroundManager.dispose()
    },

    // Register all tools (background, session, code intelligence, project guidelines)
    tool: {
      ...backgroundTools,
      ...sessionTools,
      ...codeIntelligenceTools,
      ...projectGuidelinesTools,
    },

    // Register chat.message hook (variant handling + keyword detection + agent tracking)
    "chat.message": async (
      input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } },
      output: { parts: Array<{ type: string; text?: string }>; message: VariantMessage }
    ) => {
      // Track agent and model for this session (used by system transform hook and reminders)
      setSessionContext(input.sessionID, { agent: input.agent, model: input.model })

      // Apply agent variant safely (defensive - handles undefined agent)
      const message = output.message

      if (firstMessageVariantGate.shouldOverride(input.sessionID)) {
        // First message in new session - apply configured variant
        const variant = resolveAgentVariant(pluginConfig, input.agent)
        if (variant !== undefined) {
          message.model = {
            ...message.model,
            variant,
          }
        }
        firstMessageVariantGate.markApplied(input.sessionID)
      } else {
        // Subsequent messages - apply variant if not already set
        applyAgentVariant(pluginConfig, input.agent, message)
      }

      // Run keyword detection (ultrawork/deep-research/explore)
      await keywordDetectorHook["chat.message"]?.(input, output)
    },

    // Inject agent-specific orchestration prompt into system prompt
    "experimental.chat.system.transform": async (
      input: unknown,
      output: { system: string[] }
    ) => {
      // Cast input to access sessionID (the hook actually passes it, but types say {})
      const { sessionID } = input as { sessionID?: string }
      if (!sessionID) return
      
      // Look up which agent is active for this session
      const agent = getSessionAgent(sessionID)
      const agentType = getOrchestrationAgentType(agent)
      
      // Only inject for build/plan agents
      const prompt = getOrchestrationPrompt(agentType, disabledAgents, disabledSkills)
      if (prompt) {
        output.system.push(prompt)
      }
    },

    // Handle session events
    event: async (input: { event: Event }) => {
      const { event } = input

      // Run auto-update hook (shows toast on startup, checks for updates)
      await autoUpdateHook.event(input)

      // Track main session on creation and mark for variant gate
      if (event.type === "session.created") {
        const props = event.properties as { info?: { id?: string; parentID?: string } }
        const sessionInfo = props?.info

        // Mark session for variant gate (handles null checks internally)
        firstMessageVariantGate.markSessionCreated(sessionInfo)

        // Only set main session if it's not a child session (no parent)
        if (sessionInfo?.id && !sessionInfo?.parentID) {
          backgroundManager.setMainSession(sessionInfo.id)
          // Keep bundled skills in sync with the running version (once/process)
          syncSkillsOnce()
        }
      }

      // Cleanup on session deletion
      if (event.type === "session.deleted") {
        const props = event.properties as { info?: { id?: string } }
        const sessionID = props?.info?.id

        // Clear from variant gate
        firstMessageVariantGate.clear(sessionID)

        // Clear session agent tracking
        clearSessionAgent(sessionID)

        // Detach this session's background tasks so their completions are
        // silenced and never leak into other sessions' notifications. Still-
        // running children are aborted too — nobody is left to read them.
        if (sessionID) {
          backgroundManager.detachParentSession(sessionID, ctx.client)
        }

        // Clear main session if this was it
        if (sessionID && sessionID === backgroundManager.getMainSession()) {
          backgroundManager.setMainSession(undefined)
        }
      }

      // Detect background task completion via session.idle
      if (event.type === "session.idle") {
        const props = event.properties as { sessionID?: string }
        const sessionID = props?.sessionID
        if (!sessionID) return

        // Handle background task completion
        const notification = backgroundManager.handleSessionIdle(sessionID)

        // If a background task completed, notify the session that OWNS it.
        if (notification) {
          await sendCompletionNotification(notification)
          // Don't run todo enforcer for background task completions
          return
        }

        // Not a child task's own idle — but this session might own an
        // earlier all-complete batch whose delivery failed (claim was
        // released, not confirmed). Retry it on this idle rather than
        // waiting for unrelated new background work to surface it again.
        // Scoped to allComplete only: a partial ("N still running") batch is
        // never claimed and would otherwise resend on every unrelated idle
        // while the fan-out is in flight.
        const pending = backgroundManager.getCompletionStatusForSession(sessionID)
        if (pending?.allComplete) {
          await sendCompletionNotification(pending)
          return
        }

        // KNOWN NARROW RACE (accepted trade-off, not fully closed): if this
        // session happens to go idle for an unrelated reason during the
        // brief window a *different* delivery attempt has it claimed
        // (typically a single HTTP round-trip), this idle edge is suppressed
        // by hasActiveBackgroundWork and the enforcer below is skipped for
        // it. If that in-flight delivery then fails AND the session never
        // goes idle again on its own, the todo list could still stall. This
        // requires a delivery failure to coincide with an idle edge within a
        // sub-second window, which is far narrower than the original bug
        // (any normal-speed synthesis turn) — closing it fully would need an
        // explicit "idle occurred while claimed" latch replayed once the
        // claim resolves. Not implemented: the residual probability is very
        // low and the added complexity (a second state machine cross-cutting
        // BackgroundManager and this event handler) was judged not worth it
        // for this pass.
        await todoEnforcerHook.event(input)
      }
    },

    config: async (config) => {
      // Initialize agent config if not present
      config.agent = config.agent ?? {}

      // Register custom subagents (unless disabled)
      if (!disabledAgents.has("explorer")) {
        config.agent.explorer = applyModelOverride("explorer", explorerAgent)
      }

      if (!disabledAgents.has("librarian")) {
        config.agent.librarian = applyModelOverride("librarian", librarianAgent)
      }

      if (!disabledAgents.has("oracle")) {
        config.agent.oracle = applyModelOverride("oracle", oracleAgent)
      }

      if (!disabledAgents.has("ui-planner")) {
        config.agent["ui-planner"] = applyModelOverride("ui-planner", uiPlannerAgent)
      }

      if (!disabledAgents.has("inspector")) {
        config.agent.inspector = applyModelOverride("inspector", inspectorAgent)
      }


      // Inject MCP servers (our MCPs win over user's conflicting MCPs)
      // User's other MCPs are preserved
      const builtinMcps = createBuiltinMcps(disabledMcps)
      config.mcp = {
        ...config.mcp,    // User's existing MCPs (preserved)
        ...builtinMcps,   // Our MCPs (overwrites conflicts)
      }
    },
  }
}

// Default export for OpenCode plugin system
export default ZenoxPlugin

// NOTE: Do NOT export functions from main index.ts!
// OpenCode treats ALL exports as plugin instances and calls them.
// Only export types for external usage.
export type {
  BuiltinAgentName,
  AgentOverrideConfig,
  AgentOverrides,
} from "./agents"

export type {
  ZenoxConfig,
  AgentName,
} from "./config"

export type { McpName } from "./mcp"

export type { BackgroundTask, TaskStatus } from "./background"
