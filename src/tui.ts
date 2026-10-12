/**
 * zenox terminal (CLI) plugin
 *
 * OpenCode V2 server plugins cannot render toasts, so the server plugin emits
 * them on the `zenox` RPC event channel and this plugin shows them. It also
 * shows the startup version toast ("zenox vX" / "zenox updated vA → vB").
 *
 * Loaded automatically through the package's `./tui` export.
 */

import { Plugin } from "@opencode/plugin/tui"
import { loadPluginConfig } from "./config"
import { readPackageVersion } from "./skills"
import { ZENOX_RPC, ZenoxToastSchema } from "./shared/toast"
import { buildVersionToast } from "./features/version-toast"

const VERSION_KEY = "version"

export default Plugin.define({
  id: "zenox.tui",
  setup(context) {
    const stop = context.client.rpc(ZENOX_RPC).events.on("toast", (event) => {
      // RPC events arrive from every location on the server; only show this project's.
      const here = context.location?.directory
      const from = event.location?.directory
      if (here && from && here !== from) return
      const parsed = ZenoxToastSchema.safeParse(event.data)
      if (parsed.success) context.ui.toast.show(parsed.data)
    })

    const config = loadPluginConfig(context.location?.directory ?? process.cwd())
    if (config.auto_update?.show_startup_toast !== false) {
      const version = readPackageVersion()
      const [stored, update] = context.storage.store(VERSION_KEY, {
        initial: { version: "" },
      })
      context.ui.toast.show(buildVersionToast(stored.version, version))
      update((draft) => {
        draft.version = version
      }).catch(() => {})
    }

    return () => stop()
  },
})
