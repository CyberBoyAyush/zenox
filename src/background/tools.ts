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
import { BackgroundManager, BackgroundLimitError } from "./manager"
import { getSessionModel } from "../orchestration/session-agent-tracker"

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
          "Agent to use: explorer, librarian, oracle, ui-planner, or inspector"
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
        // Get current model from session context
        const parentModel = getSessionModel(context.sessionID)

        // launch() enforces concurrency/circuit-breaker limits atomically and
        // throws BackgroundLimitError when a limit is hit.
        const task = await manager.launch(client, {
          agent: args.agent,
          description: args.description,
          prompt: args.prompt,
          parentSessionID: context.sessionID,
          parentAgent: context.agent,
          parentModel, // Track which model was active when task was launched
        })

        const activeTasks = manager.listActiveTasks()
        return `Background task launched successfully.
- Task ID: ${task.id}
- Agent: ${args.agent}
- Description: ${args.description}
- Active tasks: ${activeTasks.length}

Continue working. You will be notified when all background tasks complete.`
      } catch (err) {
        // Limit rejections return the friendly guidance message directly.
        if (err instanceof BackgroundLimitError) {
          return err.message
        }
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
    async execute(args, context) {
      const cancelled = await manager.cancel(client, args.task_id)
      if (!cancelled) {
        return `Could not cancel task ${args.task_id}. It may have already completed or does not exist.`
      }

      let output = `Task ${args.task_id} has been cancelled.`

      // If that was the last running task for this session, surface the same
      // "all complete" signal a normal completion would — otherwise the
      // caller never learns the fan-out is fully done (cancel() itself can't
      // safely push this: the parent session is mid-turn while this tool runs).
      const notification = manager.getCompletionStatusForSession(context.sessionID)
      if (notification?.allComplete) {
        output += `\n\n${notification.message}`
        // Delivered by returning it here, so the dedup flag is safe to commit
        // immediately — a tool's return value can't silently fail to reach
        // the caller the way an async session.prompt() send can.
        manager.markNotified(notification.completedTasks)
      }

      return output
    },
  })

  const backgroundList = tool({
    description: `List background tasks launched by this session with their status.
Use to check what is running, or to recover task IDs if a completion notification was lost.`,
    args: {},
    async execute(_args, context) {
      const tasks = manager
        .listAllTasks()
        .filter((t) => t.parentSessionID === context.sessionID)

      if (tasks.length === 0) {
        return "No background tasks launched by this session."
      }

      const now = Date.now()
      const lines = tasks.map((t) => {
        const end = t.completedAt?.getTime() ?? now
        const seconds = Math.round((end - t.startedAt.getTime()) / 1000)
        const error = t.error ? ` — ${t.error}` : ""
        return `- ${t.id} [${t.status}] ${t.description} (${t.agent}, ${seconds}s)${error}`
      })

      return `Background tasks for this session:\n${lines.join("\n")}\n\nUse background_output(task_id) for completed results.`
    },
  })

  return {
    background_task: backgroundTask,
    background_output: backgroundOutput,
    background_cancel: backgroundCancel,
    background_list: backgroundList,
  }
}
