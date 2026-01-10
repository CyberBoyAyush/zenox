import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import stripJsonComments from "strip-json-comments"
import type { OpencodeConfig, ConfigFormat } from "./types"
import { PACKAGE_NAME } from "./constants"

const CONFIG_FILENAMES = ["opencode.json", "opencode.jsonc"]

/**
 * Get the global OpenCode config directory
 * Follows XDG spec on Linux, uses ~/.config on macOS, handles Windows APPDATA
 */
function getGlobalConfigDir(): string {
  if (process.platform === "win32") {
    // Check cross-platform path first (~/.config)
    const crossPlatformDir = join(homedir(), ".config", "opencode")
    const crossPlatformConfig = join(crossPlatformDir, "opencode.json")
    const crossPlatformConfigJsonc = join(crossPlatformDir, "opencode.jsonc")

    if (existsSync(crossPlatformConfig) || existsSync(crossPlatformConfigJsonc)) {
      return crossPlatformDir
    }

    // Fall back to %APPDATA%
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming")
    return join(appData, "opencode")
  }

  // macOS/Linux: use XDG_CONFIG_HOME or ~/.config
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(xdgConfig, "opencode")
}

/**
 * Find OpenCode config file in order of priority:
 * 1. .opencode/opencode.json[c] (project-local subdirectory)
 * 2. opencode.json[c] (project root)
 * 3. ~/.config/opencode/opencode.json[c] (global)
 */
export function findConfigFile(directory: string): { path: string; format: ConfigFormat } | null {
  const searchPaths = [
    join(directory, ".opencode"),  // Project-local subdirectory
    directory,                      // Project root
    getGlobalConfigDir(),          // Global config
  ]

  for (const searchDir of searchPaths) {
    for (const filename of CONFIG_FILENAMES) {
      const configPath = join(searchDir, filename)
      if (existsSync(configPath)) {
        const format: ConfigFormat = filename.endsWith(".jsonc") ? "jsonc" : "json"
        return { path: configPath, format }
      }
    }
  }
  return null
}

export async function readConfig(configPath: string): Promise<{ content: string; config: OpencodeConfig }> {
  const content = await readFile(configPath, "utf-8")
  // Use proper JSONC parser that handles strings correctly
  const jsonContent = stripJsonComments(content, { trailingCommas: true })
  const config = JSON.parse(jsonContent) as OpencodeConfig
  return { content, config }
}

export function isPluginInstalled(config: OpencodeConfig): boolean {
  // Handle both "plugins" (array) and "plugin" (array) - OpenCode supports both
  const plugins = config.plugins ?? config.plugin ?? []
  return plugins.some((p) => p === PACKAGE_NAME || p.startsWith(`${PACKAGE_NAME}@`))
}

function addPluginToJsonc(content: string): string {
  // For JSONC, preserve comments by using regex insertion
  // Check for "plugins" first, then "plugin"
  const pluginsMatch = content.match(/"plugins"\s*:\s*\[/) ?? content.match(/"plugin"\s*:\s*\[/)

  if (pluginsMatch) {
    const insertIndex = content.indexOf("[", pluginsMatch.index!) + 1
    const beforeBracket = content.slice(0, insertIndex)
    const afterBracket = content.slice(insertIndex)
    const afterTrimmed = afterBracket.trimStart()

    if (afterTrimmed.startsWith("]")) {
      return `${beforeBracket}"${PACKAGE_NAME}"${afterBracket}`
    } else {
      return `${beforeBracket}"${PACKAGE_NAME}", ${afterBracket}`
    }
  } else {
    const openBraceIndex = content.indexOf("{")
    if (openBraceIndex === -1) {
      throw new Error("Invalid JSON: no opening brace found")
    }

    const beforeBrace = content.slice(0, openBraceIndex + 1)
    const afterBrace = content.slice(openBraceIndex + 1)
    const afterTrimmed = afterBrace.trimStart()

    if (afterTrimmed.startsWith("}")) {
      return `${beforeBrace}\n  "plugins": ["${PACKAGE_NAME}"]\n}`
    } else {
      return `${beforeBrace}\n  "plugins": ["${PACKAGE_NAME}"],\n  ${afterBrace.trimStart()}`
    }
  }
}

function addPluginToJson(config: OpencodeConfig): string {
  // For plain JSON, use proper parsing to maintain clean formatting
  // Preserve the key name used in original config ("plugin" or "plugins")
  const existingKey = config.plugins ? "plugins" : config.plugin ? "plugin" : "plugins"
  const existingPlugins = config.plugins ?? config.plugin ?? []
  
  const newConfig = {
    [existingKey]: [PACKAGE_NAME, ...existingPlugins],
    ...Object.fromEntries(
      Object.entries(config).filter(([key]) => key !== "plugins" && key !== "plugin")
    ),
  }
  return JSON.stringify(newConfig, null, 2) + "\n"
}

export async function installPlugin(configPath: string): Promise<void> {
  const { content, config } = await readConfig(configPath)

  if (isPluginInstalled(config)) {
    throw new Error(`${PACKAGE_NAME} is already installed`)
  }

  const isJsonc = configPath.endsWith(".jsonc")
  const newContent = isJsonc ? addPluginToJsonc(content) : addPluginToJson(config)

  await writeFile(configPath, newContent, "utf-8")
}

export function getDefaultConfigPath(directory: string): string {
  // If .opencode directory exists, create config there (project-local)
  const dotOpencodeDir = join(directory, ".opencode")
  if (existsSync(dotOpencodeDir)) {
    return join(dotOpencodeDir, "opencode.json")
  }
  // Otherwise create in project root
  return join(directory, "opencode.json")
}

export function getGlobalConfigPath(): string {
  return join(getGlobalConfigDir(), "opencode.json")
}

export async function createDefaultConfig(configPath: string): Promise<void> {
  const defaultConfig = {
    plugins: [PACKAGE_NAME],
  }
  await writeFile(configPath, JSON.stringify(defaultConfig, null, 2) + "\n", "utf-8")
}
