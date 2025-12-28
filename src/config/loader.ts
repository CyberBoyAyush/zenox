import * as fs from "fs"
import * as path from "path"
import { AyushOpenCodeConfigSchema, type AyushOpenCodeConfig } from "./schema"

/**
 * Get the user config directory based on platform
 */
function getUserConfigDir(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming")
  }
  return process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config")
}

/**
 * Load config from a specific path
 */
function loadConfigFromPath(configPath: string): AyushOpenCodeConfig | null {
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8")
      const rawConfig = JSON.parse(content)
      const result = AyushOpenCodeConfigSchema.safeParse(rawConfig)

      if (!result.success) {
        console.warn(`[ayush-opencode] Config validation error in ${configPath}:`, result.error.issues)
        return null
      }

      return result.data
    }
  } catch (err) {
    console.warn(`[ayush-opencode] Error loading config from ${configPath}:`, err)
  }
  return null
}

/**
 * Merge two configs, with override taking priority
 */
function mergeConfigs(
  base: AyushOpenCodeConfig,
  override: AyushOpenCodeConfig
): AyushOpenCodeConfig {
  return {
    ...base,
    ...override,
    agents: {
      ...base.agents,
      ...override.agents,
    },
    disabled_agents: [
      ...new Set([
        ...(base.disabled_agents ?? []),
        ...(override.disabled_agents ?? []),
      ]),
    ],
  }
}

/**
 * Load plugin configuration from user and project paths
 * Project config takes priority over user config
 */
export function loadPluginConfig(projectDirectory: string): AyushOpenCodeConfig {
  // User-level config path
  const userConfigPath = path.join(getUserConfigDir(), "opencode", "ayush-opencode.json")

  // Project-level config path
  const projectConfigPath = path.join(projectDirectory, ".opencode", "ayush-opencode.json")

  // Load user config first (base)
  let config: AyushOpenCodeConfig = loadConfigFromPath(userConfigPath) ?? {}

  // Override with project config
  const projectConfig = loadConfigFromPath(projectConfigPath)
  if (projectConfig) {
    config = mergeConfigs(config, projectConfig)
  }

  return config
}
