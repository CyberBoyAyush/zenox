import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { randomBytes } from "node:crypto"

export interface ZenoxState {
  version: string
  /** Version we already showed an "update available" toast for — avoids repeat toasts */
  notifiedUpdate?: string
}

function getStateDir(): string {
  const base =
    process.env.XDG_CONFIG_HOME ||
    (process.platform === "win32"
      ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
      : join(homedir(), ".config"))
  return join(base, "opencode")
}

const STATE_DIR = getStateDir()
const STATE_FILE = join(STATE_DIR, "zenox-state.json")

export function readState(): ZenoxState | null {
  try {
    if (!existsSync(STATE_FILE)) return null
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as ZenoxState
  } catch {
    return null
  }
}

/** Atomic write: stage to a temp file then rename to avoid partial-write corruption. */
export function writeState(state: ZenoxState): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const tmp = join(STATE_DIR, `.zenox-state-${randomBytes(4).toString("hex")}.tmp`)
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8")
    renameSync(tmp, STATE_FILE)
  } catch {
    /* silently ignore — never break plugin startup */
  }
}
