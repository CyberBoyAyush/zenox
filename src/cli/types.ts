export interface ModelConfig {
  id?: string
  name?: string
  options?: Record<string, unknown>
  variants?: Record<string, unknown>
}

export interface ProviderConfig {
  npm?: string
  name?: string
  options?: Record<string, unknown>
  models?: Record<string, ModelConfig>
}

/** V2 plugin entry: a package spec or `{ package, options }`. */
export type PluginEntry = string | { package: string; options?: Record<string, unknown> }

export interface OpencodeConfig {
  plugins?: PluginEntry[] // OpenCode V2
  plugin?: PluginEntry[]  // OpenCode V1 key (still read by V2)
  model?: string     // Default model in provider/model format
  small_model?: string
  provider?: Record<string, ProviderConfig>
  [key: string]: unknown
}

export interface UserModelInfo {
  id: string           // Full ID: "anthropic/claude-sonnet-4-5"
  displayName: string  // From config or generated
  provider: string     // "anthropic", "openai", etc.
}

export interface InstallOptions {
  noTui?: boolean
  configPath?: string
}

export type ConfigFormat = "json" | "jsonc"
