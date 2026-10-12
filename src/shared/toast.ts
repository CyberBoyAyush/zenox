import { z } from "zod"

/**
 * V2 server plugins cannot render toasts. The server plugin emits these over its
 * `zenox` RPC event channel and the `./tui` plugin shows them.
 */
export const ZenoxToastSchema = z.object({
  title: z.string().optional(),
  message: z.string(),
  variant: z.enum(["info", "success", "warning", "error"]).optional(),
  duration: z.number().optional(),
  sessionID: z.string().optional(),
})

export type ZenoxToast = z.infer<typeof ZenoxToastSchema>

export type ToastSink = (toast: ZenoxToast) => void

export const ZENOX_RPC = {
  id: "zenox",
  methods: {},
  events: {
    toast: {
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          message: { type: "string" },
          variant: { type: "string", enum: ["info", "success", "warning", "error"] },
          duration: { type: "number" },
          sessionID: { type: "string" },
        },
        required: ["message"],
      },
    },
  },
} as const
