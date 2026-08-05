export const PACKAGE_NAME = "zenox"

export type AgentName =
  | "explorer"
  | "librarian"
  | "oracle"
  | "ui-planner"
  | "inspector"

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
    defaultModel: "anthropic/claude-sonnet-4-6",
    description: "Open-source research agent",
  },
  {
    name: "oracle",
    displayName: "Oracle",
    defaultModel: "openai/gpt-5.6-sol",
    description: "Strategic technical advisor",
  },
  {
    name: "ui-planner",
    displayName: "UI-Planner",
    defaultModel: "anthropic/claude-opus-4-8",
    description: "Designer-turned-developer",
  },
  {
    name: "inspector",
    displayName: "Inspector",
    defaultModel: "anthropic/claude-sonnet-5",
    description: "Runs checks, reports PASS/FAIL ground truth",
  },
]

export const DEFAULT_MODELS: Record<AgentName, string> = {
  explorer: "anthropic/claude-haiku-4-5",
  librarian: "anthropic/claude-sonnet-4-6",
  oracle: "openai/gpt-5.6-sol",
  "ui-planner": "anthropic/claude-opus-4-8",
  inspector: "anthropic/claude-sonnet-5",
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
