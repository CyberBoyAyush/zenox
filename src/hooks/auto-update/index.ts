import type { PluginInput } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { checkForUpdate, getCachedVersion } from "./checker"
import { invalidatePackageCache } from "./cache"
import { PACKAGE_NAME, TOAST_DURATION } from "./constants"

interface AutoUpdateHookOptions {
  showStartupToast?: boolean
}

export function createAutoUpdateHook(
  ctx: PluginInput,
  options: AutoUpdateHookOptions = {}
) {
  const { showStartupToast = true } = options
  let hasChecked = false

  return {
    event: async ({ event }: { event: Event }) => {
      if (event.type !== "session.created") return
      if (hasChecked) return

      // Skip child sessions (only run on main session)
      const props = event.properties as { info?: { parentID?: string } }
      if (props?.info?.parentID) return

      hasChecked = true

      try {
        // Get cached version first (used for startup toast regardless of update check)
        const cachedVersion = await getCachedVersion()
        const updateInfo = await checkForUpdate()

        // Show startup toast with current version
        if (showStartupToast) {
          const version = updateInfo?.currentVersion ?? cachedVersion ?? "unknown"
          await showVersionToast(ctx, version)
        }

        // If no update available, we're done
        if (!updateInfo?.hasUpdate) return

        // Invalidate cache so next restart fetches new version
        await invalidatePackageCache()

        // Show update available toast
        await ctx.client.tui.showToast({
          body: {
            title: `🆕 ${PACKAGE_NAME} v${updateInfo.latestVersion}`,
            message: `Fresh update dropped! Restart to level up.`,
            variant: "success",
            duration: TOAST_DURATION,
          },
        }).catch(() => {})
      } catch {
        // Silently ignore errors - don't break plugin startup
      }
    },
  }
}

async function showVersionToast(ctx: PluginInput, version: string) {
  await ctx.client.tui.showToast({
    body: {
      title: `⚡ ${PACKAGE_NAME} v${version}`,
      message: "Agents assembled. Let's build!",
      variant: "success",
      duration: TOAST_DURATION,
    },
  }).catch(() => {})
}

export { checkForUpdate, getCachedVersion, getLatestVersion } from "./checker"
export { invalidatePackageCache } from "./cache"
export { PACKAGE_NAME, NPM_REGISTRY_URL, BUN_CACHE_DIR } from "./constants"
