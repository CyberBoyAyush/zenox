/**
 * Background Task Tools
 *
 * Three tools for background task management:
 * - background_task: Launch a background agent
 * - background_output: Get result from completed task
 * - background_cancel: Cancel a running task
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import type { BackgroundManager } from "./manager"

export type BackgroundTools = {
  [key: string]: ToolDefinition
}

export function createBackgroundTools(
  manager: BackgroundManager,
  client: OpencodeClient
): BackgroundTools {
  const backgroundTask = tool({
    description: `Launch a background agent task for parallel execution.
The task runs asynchronously while you continue working.
You will be notified when ALL background tasks complete.
Use for independent research tasks that benefit from parallelism.`,
    args: {
      agent: tool.schema
        .string()
        .describe(
          "Agent to use: explorer, librarian, oracle, or ui-planner"
        ),
      description: tool.schema
        .string()
        .describe("Short 3-5 word description for tracking (e.g., 'Find auth code')"),
      prompt: tool.schema
        .string()
        .describe("Detailed instructions for the agent to execute"),
    },
    async execute(args, context) {
      try {
        const task = await manager.launch(client, {
          agent: args.agent,
          description: args.description,
          prompt: args.prompt,
          parentSessionID: context.sessionID,
        })

        const activeTasks = manager.listActiveTasks()
        return `Background task launched successfully.
- Task ID: ${task.id}
- Agent: ${args.agent}
- Description: ${args.description}
- Active tasks: ${activeTasks.length}

Continue working. You will be notified when all background tasks complete.`
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error"
        return `Failed to launch background task: ${errorMsg}`
      }
    },
  })

  const backgroundOutput = tool({
    description: `Get the output from a completed background task.
Use this after receiving notification that tasks are complete.`,
    args: {
      task_id: tool.schema
        .string()
        .describe("Task ID from the completion notification (e.g., 'bg_abc12345')"),
    },
    async execute(args) {
      const output = await manager.getOutput(client, args.task_id)
      return output ?? `No output found for task ${args.task_id}`
    },
  })

  const backgroundCancel = tool({
    description: `Cancel a running background task.
Use if a task is no longer needed or taking too long.`,
    args: {
      task_id: tool.schema
        .string()
        .describe("Task ID to cancel"),
    },
    async execute(args) {
      const cancelled = await manager.cancel(client, args.task_id)
      if (cancelled) {
        return `Task ${args.task_id} has been cancelled.`
      }
      return `Could not cancel task ${args.task_id}. It may have already completed or does not exist.`
    },
  })

  return {
    background_task: backgroundTask,
    background_output: backgroundOutput,
    background_cancel: backgroundCancel,
  }
}
