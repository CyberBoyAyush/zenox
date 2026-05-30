import { NPM_REGISTRY_URL, BUN_CACHE_DIR, PACKAGE_NAME } from "./constants"
import { readdir } from "node:fs/promises"
import { readPackageVersion } from "../../skills/sync"

interface NpmPackageInfo {
  version: string
}

interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
}

export async function getLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(NPM_REGISTRY_URL)
    if (!response.ok) return null
    const data = (await response.json()) as NpmPackageInfo
    return data.version
  } catch {
    return null
  }
}

export async function getCachedVersion(): Promise<string | null> {
  try {
    const entries = await readdir(BUN_CACHE_DIR)
    return extractVersionFromEntries(entries)
  } catch {
    return null
  }
}

export function findPluginEntry(entries: string[]): string | null {
  // Match entries like "zenox@1.0.0@@@1" (without version pinning)
  const unpinnedPattern = new RegExp(`^${PACKAGE_NAME}@[^@]+@@@\\d+$`)
  return entries.find((e) => unpinnedPattern.test(e)) ?? null
}

export function isVersionPinned(entries: string[]): boolean {
  // Pinned versions have double @@ before version: zenox@@1.0.0@@@1
  const pinnedPattern = new RegExp(`^${PACKAGE_NAME}@@`)
  return entries.some((e) => pinnedPattern.test(e))
}

function extractVersionFromEntries(entries: string[]): string | null {
  const pluginEntry = findPluginEntry(entries)
  if (!pluginEntry) return null

  // Extract version from format: zenox@1.0.0@@@1
  const match = pluginEntry.match(new RegExp(`^${PACKAGE_NAME}@([^@]+)@@@`))
  return match?.[1] ?? null
}

/** Returns the running version regardless of install method. */
export async function getCurrentVersion(): Promise<string | null> {
  try {
    const entries = await readdir(BUN_CACHE_DIR)
    if (isVersionPinned(entries)) return readPackageVersion() || null
    const cached = extractVersionFromEntries(entries)
    if (cached) return cached
  } catch {
    /* Bun cache unavailable — fall through */
  }
  const pkg = readPackageVersion()
  return pkg !== "0.0.0" ? pkg : null
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const currentVersion = await getCurrentVersion()
    if (!currentVersion) return null

    const latestVersion = await getLatestVersion()
    if (!latestVersion) return null

    return {
      currentVersion,
      latestVersion,
      hasUpdate: latestVersion !== currentVersion,
    }
  } catch {
    return null
  }
}

/** True when the bun cache entry is version-pinned (zenox@@x.y.z@@@n). */
export async function isCachePinned(): Promise<boolean> {
  try {
    const entries = await readdir(BUN_CACHE_DIR)
    return isVersionPinned(entries)
  } catch {
    return false
  }
}
