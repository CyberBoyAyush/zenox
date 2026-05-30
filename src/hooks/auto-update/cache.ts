import { rm, readdir } from "node:fs/promises"
import { join } from "node:path"
import { OC_CACHE_DIR, PACKAGE_NAME } from "./constants"

/**
 * Delete the OpenCode plugin cache entry for zenox so that OC re-downloads
 * the latest version on next startup.
 *
 * Prefers deleting zenox@latest (unpinned). Also deletes any versioned entries
 * so a pinned-then-unpinned user doesn't get served a stale version.
 *
 * Returns true if at least one entry was removed.
 */
export async function invalidatePackageCache(): Promise<boolean> {
  try {
    const entries = await readdir(OC_CACHE_DIR)
    const toDelete = entries.filter((e) => e.startsWith(`${PACKAGE_NAME}@`))
    if (toDelete.length === 0) return false

    await Promise.all(
      toDelete.map((entry) =>
        rm(join(OC_CACHE_DIR, entry), { recursive: true, force: true })
      )
    )
    return true
  } catch {
    return false
  }
}
