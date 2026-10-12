import { z } from "zod"
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"

/**
 * Register a tool whose input is validated with Zod but advertised to the model
 * as plain JSON Schema (the documented V2 Promise-plugin format), so the schema
 * reaches the model regardless of Standard Schema → JSON Schema support.
 */
export function addZodTool<S extends z.ZodObject>(
  editor: ToolEditor,
  definition: {
    name: string
    description: string
    /** Permission action checked before execution (defaults to the host's choice). */
    permission?: string
    schema: S
    execute: (input: z.infer<S>, context: ToolContext) => Promise<string> | string
  }
): void {
  const { $schema: _dialect, ...input } = z.toJSONSchema(definition.schema)
  editor.add({
    name: definition.name,
    description: definition.description,
    input,
    ...(definition.permission ? { options: { permission: definition.permission } } : {}),
    execute: async (raw, context) => {
      const parsed = definition.schema.safeParse(raw ?? {})
      if (!parsed.success) {
        return { content: `Invalid input for ${definition.name}: ${z.prettifyError(parsed.error)}` }
      }
      return { content: await definition.execute(parsed.data, context) }
    },
  })
}
