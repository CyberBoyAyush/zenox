import { spawnSync } from "node:child_process"
import pc from "picocolors"
import { intro, outro, log } from "@clack/prompts"
import { PACKAGE_NAME } from "./constants"

/**
 * OpenCode V2 manages plugin packages itself. `zenox update` delegates to
 * `opencode plugin update zenox`, which also respects exact-version pins.
 */
export async function runUpdate(): Promise<void> {
  intro(pc.bold(`${PACKAGE_NAME} update`))

  const result = spawnSync("opencode", ["plugin", "update", PACKAGE_NAME], { stdio: "inherit" })

  if (result.error) {
    log.error(`Could not run the OpenCode CLI: ${result.error.message}`)
    log.info(`Run ${pc.cyan(`opencode plugin update ${PACKAGE_NAME}`)} manually.`)
    process.exit(1)
  }
  if (result.status !== 0) {
    log.error(`opencode plugin update exited with code ${result.status ?? "unknown"}`)
    process.exit(result.status ?? 1)
  }

  outro(pc.green("Done! Restart OpenCode (or `opencode service restart`) to apply the update."))
}
