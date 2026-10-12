import type { RemoteMcpServerConfig } from "./types"

/**
 * grep.app MCP Server - GitHub code search
 * 
 * Provides tools:
 * - grep_app_searchGitHub: Search real-world code examples from GitHub
 * 
 * Remote MCP - No API key required!
 */
export const grep_app: RemoteMcpServerConfig = {
  type: "remote",
  url: "https://mcp.grep.app",
  disabled: false,
}
