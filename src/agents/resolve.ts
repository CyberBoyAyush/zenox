import type { ZenoxConfig } from "../config"
import { explorerAgent } from "./explorer"
import { librarianAgent } from "./librarian"
import { oracleAgent } from "./oracle"
import { uiPlannerAgent } from "./ui-planner"
import { inspectorAgent } from "./inspector"
import type { AgentOverrideConfig, BuiltinAgentName, ZenoxAgentDefinition } from "./types"

export const BUILTIN_AGENTS: Readonly<Record<BuiltinAgentName, ZenoxAgentDefinition>> = {
  explorer: explorerAgent,
  librarian: librarianAgent,
  oracle: oracleAgent,
  "ui-planner": uiPlannerAgent,
  inspector: inspectorAgent,
}

/**
 * Combine the built-in model with zenox.json overrides into `provider/model[#variant]`.
 * An overriding model drops the built-in variant unless it carries its own; an
 * explicit `variant` always wins.
 */
export function resolveAgentModel(
  builtinModel: string,
  override: AgentOverrideConfig | undefined
): string {
  const [builtinBase, builtinVariant] = builtinModel.split("#", 2)
  const [overrideBase, overrideVariant] = override?.model?.split("#", 2) ?? []
  const base = overrideBase || builtinBase
  const variant = override?.variant ?? (overrideBase ? overrideVariant : builtinVariant)
  return variant ? `${base}#${variant}` : base
}

/** Enabled agents with their final model strings applied. */
export function resolveAgents(
  config: ZenoxConfig
): Array<[BuiltinAgentName, ZenoxAgentDefinition]> {
  const disabled = new Set(config.disabled_agents ?? [])
  return (Object.entries(BUILTIN_AGENTS) as Array<[BuiltinAgentName, ZenoxAgentDefinition]>)
    .filter(([name]) => !disabled.has(name))
    .map(([name, agent]) => [
      name,
      { ...agent, model: resolveAgentModel(agent.model, config.agents?.[name]) },
    ])
}
