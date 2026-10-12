import type { LocalMcpServerConfig } from "./types"

/**
 * Sequential Thinking MCP Server - Structured reasoning
 * 
 * Provides tools:
 * - sequential-thinking_sequentialthinking: Dynamic problem-solving through thoughts
 * 
 * Useful for:
 * - Breaking down complex problems
 * - Multi-step planning with revision capability
 * - Architecture decisions and analysis
 */
export const sequentialThinking: LocalMcpServerConfig = {
  type: "local",
  command: ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"],
  disabled: false,
}
