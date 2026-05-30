import { readFileSync, writeFileSync } from "node:fs"
import pc from "picocolors"
import { intro, outro, spinner, log } from "@clack/prompts"
import { getLatestVersion, getCurrentVersion } from "../hooks/auto-update/checker"
import { invalidatePackageCache } from "../hooks/auto-update/cache"
import { readState, writeState } from "../hooks/auto-update/state"
import { PACKAGE_NAME } from "../hooks/auto-update/constants"
import { findConfigFile } from "./config-manager"
import stripJsonComments from "strip-json-comments"
import type { OpencodeConfig } from "./types"

interface PinnedEntry {
  configPath: string
  pinnedVersion: string
}

/**
 * Scan all opencode.json[c] files (project + global) for a pinned zenox entry.
 * Returns the first pinned entry found, or null if unpinned / not found.
 */
function findPinnedEntry(): PinnedEntry | null {
  const configFile = findConfigFile(process.cwd())
  if (!configFile) return null

  try {
    const raw = readFileSync(configFile.path, "utf-8")
    const config = JSON.parse(stripJsonComments(raw, { trailingCommas: true })) as OpencodeConfig
    const plugins = config.plugins ?? config.plugin ?? []
    const pinnedEntry = plugins.find(
      (p) => p.startsWith(`${PACKAGE_NAME}@`) && p !== `${PACKAGE_NAME}@latest`
    )
    if (!pinnedEntry) return null
    // Extract version from "zenox@1.7.1"
    const pinnedVersion = pinnedEntry.slice(PACKAGE_NAME.length + 1)
    return { configPath: configFile.path, pinnedVersion }
  } catch {
    return null
  }
}

/** Update the version pin in opencode.json[c] from oldVersion to newVersion. */
function updatePinnedVersion(configPath: string, oldVersion: string, newVersion: string): void {
  const raw = readFileSync(configPath, "utf-8")
  const updated = raw.replaceAll(
    `${PACKAGE_NAME}@${oldVersion}`,
    `${PACKAGE_NAME}@${newVersion}`
  )
  writeFileSync(configPath, updated, "utf-8")
}

export async function runUpdate(): Promise<void> {
  intro(pc.bold(`${PACKAGE_NAME} update`))

  const s = spinner()

  // 1. Resolve current version
  s.start("Checking current version…")
  const currentVersion = await getCurrentVersion()
  const pinnedEntry = findPinnedEntry()

  s.stop(
    currentVersion
      ? `Current version: ${pc.cyan(`v${currentVersion}`)}${pinnedEntry ? pc.dim(` (pinned in ${pinnedEntry.configPath})`) : ""}`
      : `Current version: ${pc.yellow("unknown")}`
  )

  // 2. Fetch latest from npm
  s.start("Fetching latest from npm…")
  const latestVersion = await getLatestVersion()
  s.stop(
    latestVersion
      ? `Latest version:  ${pc.cyan(`v${latestVersion}`)}`
      : `Latest version:  ${pc.yellow("unavailable — check your internet connection")}`
  )

  if (!latestVersion) {
    log.error("Could not reach npm registry.")
    process.exit(1)
  }

  if (currentVersion === latestVersion) {
    outro(pc.green(`Already up to date — v${currentVersion}`))
    return
  }

  const arrow = currentVersion ? `v${currentVersion} → v${latestVersion}` : `→ v${latestVersion}`
  log.info(`Updating ${pc.bold(PACKAGE_NAME)}: ${pc.yellow(arrow)}`)
  log.info(pc.dim("Your zenox.json config and agent settings will not be touched."))

  // 3. Update version pin in opencode.json if it was pinned
  if (pinnedEntry) {
    s.start(`Updating version pin in ${pinnedEntry.configPath}…`)
    try {
      updatePinnedVersion(pinnedEntry.configPath, pinnedEntry.pinnedVersion, latestVersion)
      s.stop(`Updated pin: ${pc.dim(`${PACKAGE_NAME}@${pinnedEntry.pinnedVersion}`)} → ${pc.cyan(`${PACKAGE_NAME}@${latestVersion}`)}`)
    } catch (err) {
      s.stop(pc.yellow(`Could not update pin: ${err instanceof Error ? err.message : String(err)}`))
      log.warn("You may need to manually update the version in your opencode.json.")
    }
  } else {
    log.step(pc.dim(`Plugin is unpinned — OpenCode will pull the latest on restart.`))
  }

  // 4. Clear the OpenCode plugin cache so the next OC restart downloads the new version
  s.start("Clearing OpenCode plugin cache…")
  const cleared = await invalidatePackageCache()
  s.stop(
    cleared
      ? "Cache cleared — OpenCode will download the new version on restart."
      : pc.dim("No cache entry found (OpenCode will fetch fresh on next start anyway).")
  )

  // 5. Update state so the next OC session shows the "Updated!" toast
  const state = readState()
  writeState({
    version: currentVersion ?? state?.version ?? latestVersion,
    notifiedUpdate: state?.notifiedUpdate,
  })

  outro(
    pc.green(`Done! Restart OpenCode to apply v${latestVersion}.`)
  )
}
