import type { ZenoxToast } from "../../shared/toast"

const TOAST_DURATION = 5000

const SEMVER = /^(\d+)\.(\d+)\.(\d+)/

function isUpgrade(previous: string, current: string): boolean {
  const a = SEMVER.exec(previous)
  const b = SEMVER.exec(current)
  if (!a || !b) return false
  for (let i = 1; i <= 3; i++) {
    const diff = Number(b[i]) - Number(a[i])
    if (diff !== 0) return diff > 0
  }
  return false
}

/** Startup toast: "updated vA → vB" after an upgrade, otherwise the running version. */
export function buildVersionToast(previousVersion: string, currentVersion: string): ZenoxToast {
  if (previousVersion && isUpgrade(previousVersion, currentVersion)) {
    return {
      title: "✅ zenox updated!",
      message: `v${previousVersion} → v${currentVersion}`,
      variant: "success",
      duration: TOAST_DURATION,
    }
  }
  return {
    title: `⚡ zenox v${currentVersion}`,
    message: "Agents assembled. Let's build!",
    variant: "success",
    duration: TOAST_DURATION,
  }
}
