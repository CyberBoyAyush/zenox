import { existsSync } from "node:fs"
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import type { AgentName, McpName } from "./constants"

export interface ZenoxConfigAgents {
  [key: string]: { model: string }
}

export interface ZenoxConfig {
  agents?: ZenoxConfigAgents
  disabled_agents?: string[]
  disabled_mcps?: McpName[]
}

export function getZenoxConfigPath(): string {
  return join(homedir(), ".config", "opencode", "zenox.json")
}

export async function readZenoxConfig(): Promise<ZenoxConfig | null> {
  const configPath = getZenoxConfigPath()
  if (!existsSync(configPath)) return null

  try {
    const content = await readFile(configPath, "utf-8")
    return JSON.parse(content) as ZenoxConfig
  } catch {
    return null
  }
}

export async function writeZenoxConfig(config: ZenoxConfig): Promise<void> {
  const configPath = getZenoxConfigPath()
  const configDir = dirname(configPath)

  // Ensure directory exists
  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true })
  }

  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")
}

export async function updateAgentModels(
  models: Partial<Record<AgentName, string>>
): Promise<void> {
  const existing = (await readZenoxConfig()) ?? {}
  const configPath = getZenoxConfigPath()

  // Build new agents config (replaces existing, doesn't merge)
  const agents: ZenoxConfigAgents = {}
  for (const [agent, model] of Object.entries(models)) {
    if (model) {
      agents[agent] = { model }
    }
  }

  // If no custom agents and no other config, delete the file
  if (Object.keys(agents).length === 0) {
    const { agents: _, ...rest } = existing
    if (Object.keys(rest).length === 0) {
      if (existsSync(configPath)) {
        await unlink(configPath)
      }
      return
    }
    // Keep other config but remove agents
    await writeZenoxConfig(rest)
    return
  }

  await writeZenoxConfig({
    ...existing,
    agents,
  })
}

export function getCurrentModels(
  config: ZenoxConfig | null
): Partial<Record<AgentName, string>> {
  if (!config?.agents) return {}

  const result: Partial<Record<AgentName, string>> = {}
  for (const [agent, settings] of Object.entries(config.agents)) {
    if (settings?.model) {
      result[agent as AgentName] = settings.model
    }
  }
  return result
}

export function getDisabledMcps(config: ZenoxConfig | null): McpName[] {
  return config?.disabled_mcps ?? []
}

export async function updateDisabledMcps(disabledMcps: McpName[]): Promise<void> {
  const existing = (await readZenoxConfig()) ?? {}
  const configPath = getZenoxConfigPath()

  if (disabledMcps.length === 0) {
    // Remove the disabled_mcps field
    const { disabled_mcps: _, ...rest } = existing
    if (Object.keys(rest).length === 0) {
      // Delete the file if it would be empty
      if (existsSync(configPath)) {
        await unlink(configPath)
      }
      return
    }
    await writeZenoxConfig(rest)
  } else {
    await writeZenoxConfig({
      ...existing,
      disabled_mcps: disabledMcps,
    })
  }
}
