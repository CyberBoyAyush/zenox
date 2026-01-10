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
 * Only model override is supported - keeps it simple
 */
export const AgentOverrideConfigSchema = z.object({
  model: z.string().optional(),
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
 * Main configuration schema for zenox
 */
export const ZenoxConfigSchema = z.object({
  $schema: z.string().optional(),
  agents: AgentOverridesSchema.optional(),
  disabled_agents: z.array(AgentNameSchema).optional(),
  disabled_mcps: z.array(McpNameSchema).optional(),
})

export type ZenoxConfig = z.infer<typeof ZenoxConfigSchema>
