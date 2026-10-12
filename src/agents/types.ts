export type BuiltinAgentName =
  | "explorer"
  | "librarian"
  | "oracle"
  | "ui-planner"
  | "inspector"

/** One ordered OpenCode V2 permission rule. The last matching rule wins. */
export interface PermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

/** API-agnostic agent definition; translated onto V2 `Agent.Info` at registration. */
export interface ZenoxAgentDefinition {
  readonly description: string
  readonly mode: "subagent" | "primary" | "all"
  /** `provider/model` with an optional `#variant` suffix. */
  readonly model: string
  readonly color: string
  readonly system: string
  readonly permissions: readonly PermissionRule[]
}

export interface AgentOverrideConfig {
  model?: string
  variant?: string
}

export type AgentOverrides = Partial<Record<BuiltinAgentName, AgentOverrideConfig>>
