#!/usr/bin/env node
import { Command } from "commander"
import { runInstall } from "./install"
import { runConfig } from "./config"
import { runMcp } from "./mcp"
import {
  syncBundledSkills,
  readPackageVersion,
  getGlobalSkillsDir,
  findBundledSkillsDir,
} from "../skills"
import { readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

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

const skills = program
  .command("skills")
  .description("Manage Zenox bundled skills")

skills
  .command("install", { isDefault: true })
  .alias("update")
  .description("Install or update bundled skills into the global skills directory")
  .action(() => {
    try {
      const result = syncBundledSkills({ packageVersion: readPackageVersion() })
      const changed = [...result.installed, ...result.updated]
      if (changed.length > 0) {
        console.log(`Synced skill(s) to ${getGlobalSkillsDir()}: ${changed.join(", ")}`)
      } else {
        console.log("Skills already up to date")
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Unknown error")
      process.exit(1)
    }
  })

skills
  .command("list")
  .description("List bundled skills")
  .action(() => {
    const bundledDir = findBundledSkillsDir()
    if (!bundledDir) {
      console.log("No bundled skills found")
      return
    }
    const names = readdirSync(bundledDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(bundledDir, e.name, "SKILL.md")))
      .map((e) => e.name)
    console.log(names.length > 0 ? names.join("\n") : "No bundled skills found")
  })

program.parse()
