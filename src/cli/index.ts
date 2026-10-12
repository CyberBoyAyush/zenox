#!/usr/bin/env node
import { Command } from "commander"
import { runInstall } from "./install"
import { runConfig } from "./config"
import { runMcp } from "./mcp"
import { runUpdate } from "./update"
import { readPackageVersion, loadBundledSkills } from "../skills"

const program = new Command()

program
  .name("zenox")
  .description("Zenox - OpenCode plugin for intelligent agent orchestration")
  .version(readPackageVersion())

program
  .command("install")
  .description("Add zenox to your opencode.json plugins and configure models")
  .option("--no-tui", "Run in non-interactive mode (uses default models)")
  .option("-c, --config <path>", "Path to opencode.json")
  .action(async (options: { tui: boolean; config?: string }) => {
    try {
      await runInstall({
        noTui: !options.tui,
        configPath: options.config,
      })
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Unknown error")
      process.exit(1)
    }
  })

program
  .command("config")
  .alias("models")
  .description("Reconfigure sub-agent models")
  .action(async () => {
    try {
      await runConfig()
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Unknown error")
      process.exit(1)
    }
  })

program
  .command("mcp")
  .description("Configure MCP servers (enable/disable)")
  .action(async () => {
    try {
      await runMcp()
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Unknown error")
      process.exit(1)
    }
  })

program
  .command("update")
  .description("Update zenox via `opencode plugin update zenox`")
  .action(async () => {
    try {
      await runUpdate()
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Unknown error")
      process.exit(1)
    }
  })

program
  .command("skills")
  .description("List bundled skills (registered automatically by the plugin)")
  .action(() => {
    const skills = loadBundledSkills([])
    console.log(skills.length > 0 ? skills.map((s) => s.id).join("\n") : "No bundled skills found")
  })

program.parse()
