import { BUILTIN_AGENTS } from "../agents/resolve"

export const PACKAGE_NAME = "zenox"

/** Built-in model without its variant, straight from the agent definitions (never drifts). */
const builtinModel = (name: AgentName): string => BUILTIN_AGENTS[name].model.split("#", 2)[0]

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
    defaultModel: builtinModel("explorer"),
    description: "Fast codebase search specialist",
  },
  {
    name: "librarian",
    displayName: "Librarian",
    defaultModel: builtinModel("librarian"),
    description: "Open-source research agent",
  },
  {
    name: "oracle",
    displayName: "Oracle",
    defaultModel: builtinModel("oracle"),
    description: "Strategic technical advisor",
  },
  {
    name: "ui-planner",
    displayName: "UI-Planner",
    defaultModel: builtinModel("ui-planner"),
    description: "Designer-turned-developer",
  },
  {
    name: "inspector",
    displayName: "Inspector",
    defaultModel: builtinModel("inspector"),
    description: "Runs checks, reports PASS/FAIL ground truth",
  },
]

export const DEFAULT_MODELS: Record<AgentName, string> = {
  explorer: builtinModel("explorer"),
  librarian: builtinModel("librarian"),
  oracle: builtinModel("oracle"),
  "ui-planner": builtinModel("ui-planner"),
  inspector: builtinModel("inspector"),
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
