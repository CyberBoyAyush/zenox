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
} from "./agents"
import { getOrchestrationPrompt } from "./orchestration/prompt"
import {
  setSessionContext,
  getSessionAgent,
  clearSessionAgent,
  getOrchestrationAgentType,
} from "./orchestration/session-agent-tracker"
import { loadPluginConfig, type AgentName } from "./config"
import { createBuiltinMcps } from "./mcp"
import { BackgroundManager, createBackgroundTools } from "./background"
import {
  createAutoUpdateHook,
  createKeywordDetectorHook,
  createTodoEnforcerHook,
} from "./hooks"
import { TaskToastManager } from "./features/task-toast"
import { createSessionTools } from "./tools/session"
import { createCodeIntelligenceTools } from "./tools/code-intelligence"
import {
  resolveAgentVariant,
  applyAgentVariant,
  createFirstMessageVariantGate,
} from "./shared"

const ZenoxPlugin: Plugin = async (ctx) => {
  // Load user/project configuration
  const pluginConfig = loadPluginConfig(ctx.directory)
  const disabledAgents = new Set(pluginConfig.disabled_agents ?? [])
  const disabledMcps = pluginConfig.disabled_mcps ?? []

  // Initialize toast manager for background tasks
  const taskToastManager = new TaskToastManager(ctx.client)

  // Initialize background task manager with toast integration
  const backgroundManager = new BackgroundManager()
  backgroundManager.setToastManager(taskToastManager)
  const backgroundTools = createBackgroundTools(backgroundManager, ctx.client)

  // Initialize hooks
  const autoUpdateHook = createAutoUpdateHook(ctx)
  const keywordDetectorHook = createKeywordDetectorHook(ctx)
  const todoEnforcerHook = createTodoEnforcerHook(ctx)

  // Initialize session and code intelligence tools
  const sessionTools = createSessionTools(ctx.client)
  const codeIntelligenceTools = createCodeIntelligenceTools(ctx.client)

  // Initialize variant gate for safe variant application on first message
  const firstMessageVariantGate = createFirstMessageVariantGate()

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
    // Register all tools (background, session, code intelligence)
    tool: {
      ...backgroundTools,
      ...sessionTools,
      ...codeIntelligenceTools,
    },

    // Register chat.message hook (variant handling + keyword detection + agent tracking)
    "chat.message": async (
      input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } },
      output: { parts: Array<{ type: string; text?: string }>; message: Record<string, unknown> }
    ) => {
      // Track agent and model for this session (used by system transform hook and reminders)
      setSessionContext(input.sessionID, { agent: input.agent, model: input.model })

      // Apply agent variant safely (defensive - handles undefined agent)
      const message = output.message as { variant?: string }

      if (firstMessageVariantGate.shouldOverride(input.sessionID)) {
        // First message in new session - apply configured variant
        const variant = resolveAgentVariant(pluginConfig, input.agent)
        if (variant !== undefined) {
          message.variant = variant
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
      const prompt = getOrchestrationPrompt(agentType)
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

        // If a background task completed, notify the main session
        if (notification) {
          const mainSessionID = backgroundManager.getMainSession()
          if (mainSessionID) {
            // Send notification with retry logic for undefined agent/model errors
            const sendNotification = async (omitContext = false) => {
              try {
                await ctx.client.session.prompt({
                  path: { id: mainSessionID },
                  body: {
                    // noReply: true = silent (don't trigger response)
                    // noReply: false = loud (trigger response)
                    noReply: !notification.allComplete,
                    // Preserve the agent and model (omit if retry due to undefined error)
                    ...(omitContext ? {} : { agent: notification.parentAgent }),
                    ...(omitContext ? {} : { model: notification.parentModel }),
                    parts: [{ type: "text", text: notification.message }],
                  },
                })
              } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err)
                // Retry without agent/model if we hit the undefined error
                if (!omitContext && (errorMsg.includes("agent") || errorMsg.includes("model") || errorMsg.includes("undefined"))) {
                  return sendNotification(true)
                }
                // Silently ignore other errors
              }
            }
            await sendNotification()
          }
          // Don't run todo enforcer for background task completions
          return
        }

        // Run todo enforcer for main session idle (not background tasks)
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
