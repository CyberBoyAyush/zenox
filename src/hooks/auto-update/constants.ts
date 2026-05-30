import { homedir } from "node:os"
import { join } from "node:path"

export const PACKAGE_NAME = "zenox"
export const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`

// OpenCode's own plugin cache: ~/.cache/opencode/packages/
export const OC_CACHE_DIR = join(homedir(), ".cache", "opencode", "packages")

// Toast display duration in milliseconds
export const TOAST_DURATION = 5000
