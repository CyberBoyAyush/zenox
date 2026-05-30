import { OC_CACHE_DIR, NPM_REGISTRY_URL, PACKAGE_NAME } from "./constants"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
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

/**
 * Read the installed version from the OpenCode plugin cache.
 * OC stores plugins at ~/.cache/opencode/packages/zenox@<spec>/node_modules/zenox/package.json
 * We prefer the @latest entry, then any versioned entry, then readPackageVersion() fallback.
 */
export async function getCachedVersion(): Promise<string | null> {
  try {
    const entries = await readdir(OC_CACHE_DIR)
    // Prefer the @latest entry — that's what unpinned users load
    const preferred = entries.find((e) => e === `${PACKAGE_NAME}@latest`)
    // Fall back to the highest-versioned pinned entry
    const fallback = entries
      .filter((e) => e.startsWith(`${PACKAGE_NAME}@`) && e !== `${PACKAGE_NAME}@latest`)
      .sort()
      .at(-1)

    for (const entry of [preferred, fallback]) {
      if (!entry) continue
      const pkgPath = join(OC_CACHE_DIR, entry, "node_modules", PACKAGE_NAME, "package.json")
      try {
        const raw = await readFile(pkgPath, "utf-8")
        const pkg = JSON.parse(raw) as { version?: string }
        if (pkg.version) return pkg.version
      } catch {
        /* entry exists but package.json unreadable — keep trying */
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Returns true when the currently loaded plugin entry in OC cache is a pinned version
 * (e.g. zenox@1.7.2) rather than zenox@latest.
 * Pinned entries must be updated via `zenox update`; cache-clear alone won't upgrade them.
 */
export async function isCachePinned(): Promise<boolean> {
  try {
    const entries = await readdir(OC_CACHE_DIR)
    // If @latest exists, the user is on unpinned — not pinned
    if (entries.includes(`${PACKAGE_NAME}@latest`)) return false
    // If only versioned entries exist, it's pinned
    return entries.some(
      (e) => e.startsWith(`${PACKAGE_NAME}@`) && e !== `${PACKAGE_NAME}@latest`
    )
  } catch {
    return false
  }
}

/**
 * Returns the running version of zenox regardless of install method.
 * Priority: OC cache package.json → readPackageVersion() (import.meta.url walk-up)
 */
export async function getCurrentVersion(): Promise<string | null> {
  const cached = await getCachedVersion()
  if (cached) return cached
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
