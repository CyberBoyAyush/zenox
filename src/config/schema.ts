import { z } from "zod"
import { McpNameSchema } from "../mcp/types"

/**
 * Agent names that can be configured
 */
export const AgentNameSchema = z.enum([
  "explorer",
  "librarian",
  "oracle",
  "ui-planner",
])

export type AgentName = z.infer<typeof AgentNameSchema>

/**
 * Configuration for overriding an agent's settings
 * Supports model and variant overrides for thinking modes
 */
export const AgentOverrideConfigSchema = z.object({
  model: z.string().optional(),
  variant: z.string().optional(),
})

export type AgentOverrideConfig = z.infer<typeof AgentOverrideConfigSchema>

/**
 * Agent overrides mapping
 */
export const AgentOverridesSchema = z.object({
  explorer: AgentOverrideConfigSchema.optional(),
  librarian: AgentOverrideConfigSchema.optional(),
  oracle: AgentOverrideConfigSchema.optional(),
  "ui-planner": AgentOverrideConfigSchema.optional(),
})

export type AgentOverrides = z.infer<typeof AgentOverridesSchema>

/**
 * Background task concurrency limits.
 * Guards against runaway parallel fan-out exhausting the user's usage limit.
 */
export const BackgroundConfigSchema = z.object({
  /** Max simultaneously running background tasks. */
  max_concurrent: z.number().int().min(1).max(50).default(6),
  /** Max total background tasks a single session may spawn (circuit breaker). */
  max_per_session: z.number().int().min(1).max(500).default(50),
})

export type BackgroundConfig = z.infer<typeof BackgroundConfigSchema>

/**
 * Auto-update behavior config.
 */
export const AutoUpdateConfigSchema = z.object({
  /** Show the startup version toast on session start (default: true). */
  show_startup_toast: z.boolean().optional(),
})

export type AutoUpdateConfig = z.infer<typeof AutoUpdateConfigSchema>

/**
 * Main configuration schema for zenox
 */
export const ZenoxConfigSchema = z.object({
  $schema: z.string().optional(),
  agents: AgentOverridesSchema.optional(),
  auto_update: AutoUpdateConfigSchema.optional(),
  disabled_agents: z.array(AgentNameSchema).optional(),
  disabled_mcps: z.array(McpNameSchema).optional(),
  disabled_skills: z.array(z.string()).optional(),
  background: BackgroundConfigSchema.optional(),
})

export type ZenoxConfig = z.infer<typeof ZenoxConfigSchema>
