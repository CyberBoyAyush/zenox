export const PACKAGE_NAME = "zenox"

export type AgentName = "explorer" | "librarian" | "oracle" | "ui-planner"

export interface AgentInfo {
  name: AgentName
  displayName: string
  defaultModel: string
  description: string
}

export const AGENTS: AgentInfo[] = [
  {
    name: "explorer",
    displayName: "Explorer",
    defaultModel: "anthropic/claude-haiku-4-5",
    description: "Fast codebase search specialist",
  },
  {
    name: "librarian",
    displayName: "Librarian",
    defaultModel: "anthropic/claude-sonnet-4-5",
    description: "Open-source research agent",
  },
  {
    name: "oracle",
    displayName: "Oracle",
    defaultModel: "openai/gpt-5.3-codex",
    description: "Strategic technical advisor",
  },
  {
    name: "ui-planner",
    displayName: "UI-Planner",
    defaultModel: "google/gemini-3-pro-high",
    description: "Designer-turned-developer",
  },
]

export const DEFAULT_MODELS: Record<AgentName, string> = {
  explorer: "anthropic/claude-haiku-4-5",
  librarian: "anthropic/claude-sonnet-4-5",
  oracle: "openai/gpt-5.3-codex",
  "ui-planner": "google/gemini-3-pro-high",
}

export type McpName = "exa" | "grep_app" | "sequential-thinking"

export interface McpInfo {
  name: McpName
  displayName: string
  description: string
  recommended: boolean
}

export const MCP_SERVERS: McpInfo[] = [
  {
    name: "exa",
    displayName: "Exa",
    description: "Web search & code context via Exa AI",
    recommended: true,
  },
  {
    name: "grep_app",
    displayName: "grep.app",
    description: "GitHub code search - find real-world examples",
    recommended: true,
  },
  {
    name: "sequential-thinking",
    displayName: "Sequential Thinking",
    description: "Structured reasoning for complex problems",
    recommended: true,
  },
]
