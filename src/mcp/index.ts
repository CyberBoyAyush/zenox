import { exa } from "./exa"
import { grep_app } from "./grep-app"
import { sequentialThinking } from "./sequential-thinking"
import type { McpName } from "./types"

export { McpNameSchema, type McpName } from "./types"
export type { McpServerConfig, LocalMcpServerConfig, RemoteMcpServerConfig } from "./types"

/**
 * All built-in MCP servers provided by zenox
 */
const allBuiltinMcps = {
  exa,
  grep_app,
  "sequential-thinking": sequentialThinking,
} as const

/**
 * Creates the MCP server configurations, excluding any disabled MCPs
 * 
 * @param disabledMcps - Array of MCP names to disable
 * @returns Record of enabled MCP server configurations
 */
export function createBuiltinMcps(disabledMcps: McpName[] = []) {
  const mcps: Record<string, (typeof allBuiltinMcps)[keyof typeof allBuiltinMcps]> = {}

  for (const [name, config] of Object.entries(allBuiltinMcps)) {
    if (!disabledMcps.includes(name as McpName)) {
      mcps[name] = config
    }
  }

  return mcps
}
