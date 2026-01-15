/**
 * Agent Variant Handling
 *
 * Safely resolves and applies agent variants for thinking modes.
 * Defensive implementation to prevent "undefined is not an object" errors.
 */

import type { ZenoxConfig } from "../config"

/**
 * Safely resolve agent variant from config
 * Returns undefined if agent doesn't exist or has no variant configured
 */
export function resolveAgentVariant(
  config: ZenoxConfig,
  agentName?: string
): string | undefined {
  if (!agentName) return undefined

  const agentOverrides = config.agents as
    | Record<string, { variant?: string; model?: string }>
    | undefined

  return agentOverrides?.[agentName]?.variant
}

/**
 * Apply agent variant to message if configured
 * Safe for undefined agents - simply does nothing
 */
export function applyAgentVariant(
  config: ZenoxConfig,
  agentName: string | undefined,
  message: { variant?: string }
): void {
  const variant = resolveAgentVariant(config, agentName)
  if (variant !== undefined && message.variant === undefined) {
    message.variant = variant
  }
}
