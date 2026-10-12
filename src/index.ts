/**
 * zenox - OpenCode V2 plugin for intelligent agent orchestration
 *
 * 1. Specialized subagents: explorer, librarian, oracle, ui-planner, inspector
 * 2. Orchestration prompt injected into Build/Plan for smart delegation
 * 3. MCP servers: exa, grep_app, sequential-thinking
 * 4. Background task system for parallel agent execution
 * 5. Keyword modes, project guidelines, bundled skills
 * 6. Optional configuration via zenox.json
 *
 * Toasts are rendered by the companion terminal plugin exported as `zenox/tui`.
 */

import { Plugin } from "@opencode/plugin"
import { setupZenox } from "./plugin"

export default Plugin.define({
  id: "zenox",
  setup: (ctx) => setupZenox(ctx),
})

// NOTE: only export types from this entry. Runtime exports are reserved for the plugin definition.
export type { BuiltinAgentName, AgentOverrideConfig, AgentOverrides } from "./agents"
export type { ZenoxConfig, AgentName } from "./config"
export type { McpName } from "./mcp"
export type { BackgroundTask, TaskStatus } from "./background"
