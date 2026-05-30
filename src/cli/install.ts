import * as p from "@clack/prompts"
import pc from "picocolors"
import {
  findConfigFile,
  installPlugin,
  createDefaultConfig,
  getDefaultConfigPath,
  readConfig,
  isPluginInstalled,
} from "./config-manager"
import {
  readZenoxConfig,
  updateAgentModels,
  updateDisabledMcps,
  getCurrentModels,
  getDisabledMcps,
  getZenoxConfigPath,
} from "./zenox-config"
import {
  extractUserModels,
  askConfigureModels,
  pickModelsForAllAgents,
} from "./model-picker"
import { askConfigureMcps, pickMcpsToEnable } from "./mcp-picker"
import { PACKAGE_NAME } from "./constants"
import { syncBundledSkills, readPackageVersion } from "../skills"
import type { InstallOptions } from "./types"

/** Install/update bundled skills into the global skills dir. Never throws. */
function installSkills(): { installed: string[]; updated: string[] } {
  try {
    const result = syncBundledSkills({ packageVersion: readPackageVersion() })
    return { installed: result.installed, updated: result.updated }
  } catch {
    return { installed: [], updated: [] }
  }
}

export async function runInstall(options: InstallOptions = {}): Promise<void> {
  const { noTui = false, configPath: customConfigPath } = options
  const cwd = process.cwd()

  if (noTui) {
    await runNonInteractive(cwd, customConfigPath)
    return
  }

  await runInteractive(cwd, customConfigPath)
}

async function runInteractive(cwd: string, customConfigPath?: string): Promise<void> {
  p.intro(pc.cyan(`${PACKAGE_NAME} installer`))

  const configFile = customConfigPath
    ? { path: customConfigPath, format: "json" as const }
    : findConfigFile(cwd)

  let opencodeConfig = null

  if (!configFile) {
    const shouldCreate = await p.confirm({
      message: "No opencode.json found. Create one?",
      initialValue: true,
    })

    if (p.isCancel(shouldCreate) || !shouldCreate) {
      p.cancel("Installation cancelled")
      process.exit(0)
    }

    const configPath = getDefaultConfigPath(cwd)
    const spinner = p.spinner()
    spinner.start("Creating opencode.json")

    try {
      await createDefaultConfig(configPath)
      spinner.stop("Created opencode.json")
    } catch (err) {
      spinner.stop("Failed to create config")
      p.log.error(err instanceof Error ? err.message : "Unknown error")
      process.exit(1)
    }
  } else {
    // Config exists - check if already installed
    try {
      const result = await readConfig(configFile.path)
      opencodeConfig = result.config

      if (isPluginInstalled(opencodeConfig)) {
        p.log.info(`${PACKAGE_NAME} is already in ${configFile.path}`)
      } else {
        const shouldInstall = await p.confirm({
          message: `Add ${PACKAGE_NAME} to ${configFile.path}?`,
          initialValue: true,
        })

        if (p.isCancel(shouldInstall) || !shouldInstall) {
          p.cancel("Installation cancelled")
          process.exit(0)
        }

        const spinner = p.spinner()
        spinner.start(`Adding ${PACKAGE_NAME} to plugins`)

        try {
          await installPlugin(configFile.path)
          spinner.stop(`Added ${PACKAGE_NAME} to plugins`)
        } catch (err) {
          spinner.stop("Failed to install")
          p.log.error(err instanceof Error ? err.message : "Unknown error")
          process.exit(1)
        }
      }
    } catch (err) {
      p.log.error(`Failed to read config: ${err instanceof Error ? err.message : "Unknown error"}`)
      process.exit(1)
    }
  }

  // Model configuration step
  const configureChoice = await askConfigureModels()

  if (configureChoice === null) {
    p.cancel("Installation cancelled")
    process.exit(0)
  }

  if (configureChoice === "customize") {
    // Get user's custom models from their opencode.json
    const userModels = opencodeConfig ? extractUserModels(opencodeConfig) : []

    // Get current zenox config if exists
    const zenoxConfig = await readZenoxConfig()
    const currentModels = getCurrentModels(zenoxConfig)

    // Pick models for all agents
    const selectedModels = await pickModelsForAllAgents(userModels, currentModels)

    if (selectedModels === null) {
      p.cancel("Installation cancelled")
      process.exit(0)
    }

    // Only create zenox.json if there are custom models
    if (Object.keys(selectedModels).length > 0) {
      const spinner = p.spinner()
      spinner.start("Saving model configuration")

      try {
        await updateAgentModels(selectedModels)
        spinner.stop(`Created ${getZenoxConfigPath()}`)
      } catch (err) {
        spinner.stop("Failed to save config")
        p.log.error(err instanceof Error ? err.message : "Unknown error")
        process.exit(1)
      }
    } else {
      p.log.info("Using default models - no zenox.json needed")
    }
  }

  // MCP configuration step
  const mcpChoice = await askConfigureMcps()

  if (mcpChoice === null) {
    p.cancel("Installation cancelled")
    process.exit(0)
  }

  if (mcpChoice === "customize") {
    const zenoxConfig = await readZenoxConfig()
    const currentDisabled = getDisabledMcps(zenoxConfig)
    const disabledMcps = await pickMcpsToEnable(currentDisabled)

    if (disabledMcps === null) {
      p.cancel("Installation cancelled")
      process.exit(0)
    }

    if (disabledMcps.length > 0) {
      const spinner = p.spinner()
      spinner.start("Saving MCP configuration")

      try {
        await updateDisabledMcps(disabledMcps)
        spinner.stop(`Disabled ${disabledMcps.length} MCP(s)`)
      } catch (err) {
        spinner.stop("Failed to save MCP config")
        p.log.error(err instanceof Error ? err.message : "Unknown error")
        process.exit(1)
      }
    }
  }

  // Install/update bundled skills into the global skills dir
  const skillSpinner = p.spinner()
  skillSpinner.start("Installing skills")
  const { installed, updated } = installSkills()
  const changed = installed.length + updated.length
  skillSpinner.stop(
    changed > 0
      ? `Installed ${changed} skill(s): ${[...installed, ...updated].join(", ")}`
      : "Skills already up to date"
  )

  p.outro(pc.green(`${PACKAGE_NAME} installed successfully!`))
}

async function runNonInteractive(cwd: string, customConfigPath?: string): Promise<void> {
  const configFile = customConfigPath
    ? { path: customConfigPath, format: "json" as const }
    : findConfigFile(cwd)

  if (!configFile) {
    console.log(`Creating opencode.json with ${PACKAGE_NAME}...`)
    const configPath = getDefaultConfigPath(cwd)
    await createDefaultConfig(configPath)
    installSkills()
    console.log(`Created opencode.json with ${PACKAGE_NAME}`)
    console.log("Using default models (run 'bunx zenox config' to customize)")
    return
  }

  // Add the plugin if not already present (idempotent)
  const { config } = await readConfig(configFile.path)
  if (isPluginInstalled(config)) {
    console.log(`${PACKAGE_NAME} is already installed`)
  } else {
    console.log(`Adding ${PACKAGE_NAME} to ${configFile.path}...`)
    await installPlugin(configFile.path)
    console.log(`${PACKAGE_NAME} installed successfully!`)
    console.log("Using default models (run 'bunx zenox config' to customize)")
  }

  // Always sync skills - keeps an existing install's skills up to date too.
  const { installed, updated } = installSkills()
  const changed = installed.length + updated.length
  if (changed > 0) {
    console.log(`Installed/updated ${changed} skill(s): ${[...installed, ...updated].join(", ")}`)
  }
}
