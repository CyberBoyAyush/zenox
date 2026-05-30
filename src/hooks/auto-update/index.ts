import type { PluginInput } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { checkForUpdate, getCurrentVersion, isCachePinned } from "./checker"
import { invalidatePackageCache } from "./cache"
import { PACKAGE_NAME, TOAST_DURATION } from "./constants"
import { readState, writeState } from "./state"

interface AutoUpdateHookOptions {
  showStartupToast?: boolean
}

/** Compare two semver strings. Returns true only when next is a strict upgrade. */
function isUpgrade(prev: string, next: string): boolean {
  const parse = (v: string) => v.split(".").map(Number)
  const [pMaj, pMin, pPatch] = parse(prev)
  const [nMaj, nMin, nPatch] = parse(next)
  if (nMaj !== pMaj) return nMaj > pMaj
  if (nMin !== pMin) return nMin > pMin
  return nPatch > pPatch
}

function isValidSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+/.test(v)
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
        const currentVersion = await getCurrentVersion()
        const version = currentVersion ?? "unknown"

        // Single state read for the entire hook run
        const state = readState()
        // Accumulated next state — written once at the end
        const nextState = {
          version: isValidSemver(version) ? version : (state?.version ?? version),
          notifiedUpdate: state?.notifiedUpdate,
        }

        if (showStartupToast) {
          const prevVersion = state?.version
          const showUpdated =
            prevVersion &&
            isValidSemver(prevVersion) &&
            isValidSemver(version) &&
            isUpgrade(prevVersion, version)

          if (showUpdated) {
            await ctx.client.tui.showToast({
              body: {
                title: `✅ ${PACKAGE_NAME} updated!`,
                message: `v${prevVersion} → v${version}`,
                variant: "success",
                duration: TOAST_DURATION,
              },
            }).catch(() => {})
          } else {
            await showVersionToast(ctx, version)
          }
        }

        // Check for a newer version on npm
        const updateInfo = await checkForUpdate()
        if (updateInfo?.hasUpdate && state?.notifiedUpdate !== updateInfo.latestVersion) {
          const pinned = await isCachePinned()

          if (pinned) {
            // Pinned install: clearing cache won't help — OC will re-fetch the pinned version.
            // Tell user to run `zenox update` which updates the pin + clears cache.
            await ctx.client.tui.showToast({
              body: {
                title: `🆕 ${PACKAGE_NAME} v${updateInfo.latestVersion} available`,
                message: `Run \`zenox update\` to upgrade from v${updateInfo.currentVersion}.`,
                variant: "success",
                duration: TOAST_DURATION,
              },
            }).catch(() => {})
          } else {
            // Unpinned install: clear the cache so OC downloads the new version on next restart.
            await invalidatePackageCache()
            await ctx.client.tui.showToast({
              body: {
                title: `🆕 ${PACKAGE_NAME} v${updateInfo.latestVersion} available`,
                message: `Restart OpenCode to upgrade from v${updateInfo.currentVersion}.`,
                variant: "success",
                duration: TOAST_DURATION,
              },
            }).catch(() => {})
          }

          nextState.notifiedUpdate = updateInfo.latestVersion
        }

        // Single atomic write at the end of the hook run
        writeState(nextState)
      } catch {
        // Silently ignore errors — never break plugin startup
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

export { checkForUpdate, getCurrentVersion, getCachedVersion, getLatestVersion } from "./checker"
export { invalidatePackageCache } from "./cache"
export { PACKAGE_NAME, NPM_REGISTRY_URL, OC_CACHE_DIR } from "./constants"
export { readState, writeState } from "./state"
