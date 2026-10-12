import type { LocalMcpServerConfig } from "./types"

/**
 * Exa MCP Server - Web search and code context
 * 
 * Provides tools:
 * - exa_web_search_exa: Web search via Exa AI
 * - exa_get_code_context_exa: Code context for APIs/libraries
 * - exa_crawling_exa: URL content extraction
 * 
 * HTTP Streamable via mcp-remote - No API key required!
 */
export const exa: LocalMcpServerConfig = {
  type: "local",
  command: [
    "npx",
    "-y",
    "mcp-remote",
    "https://mcp.exa.ai/mcp?tools=web_search_exa,get_code_context_exa,crawling_exa",
  ],
  disabled: false,
}
