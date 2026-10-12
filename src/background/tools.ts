/**
 * Background Task Tools
 *
 * - background_task: Launch a background agent
 * - background_output: Get result from completed task
 * - background_cancel: Cancel a running task
 * - background_list: List this session's tasks
 */

import { z } from "zod"
import type { ToolEditor } from "@opencode/plugin/promise/tool"
import { addZodTool } from "../shared/tool"
import { BackgroundManager, BackgroundLimitError } from "./manager"

export async function launchBackgroundTask(
  manager: BackgroundManager,
  input: { agent: string; description: string; prompt: string },
  parentSessionID: string
): Promise<string> {
  // Recursion guard that does not depend on permission naming: a background
  // child may never fan out its own background work.
  if (manager.isBackgroundSession(parentSessionID)) {
    return "background_task is not available inside a background task. Do the work directly and report back."
  }
  try {
    // launch() enforces concurrency/circuit-breaker limits atomically and
    // throws BackgroundLimitError when a limit is hit.
    const task = await manager.launch({
      agent: input.agent,
      description: input.description,
      prompt: input.prompt,
      parentSessionID,
    })

    const activeTasks = manager.listActiveTasks()
    return `Background task launched successfully.
- Task ID: ${task.id}
- Agent: ${input.agent}
- Description: ${input.description}
- Active tasks: ${activeTasks.length}

Continue working. You will be notified when all background tasks complete.`
  } catch (err) {
    if (err instanceof BackgroundLimitError) {
      return err.message
    }
    const errorMsg = err instanceof Error ? err.message : "Unknown error"
    return `Failed to launch background task: ${errorMsg}`
  }
}

export async function cancelBackgroundTask(
  manager: BackgroundManager,
  taskId: string,
  sessionID: string
): Promise<string> {
  const cancelled = await manager.cancel(taskId)
  if (!cancelled) {
    return `Could not cancel task ${taskId}. It may have already completed or does not exist.`
  }

  let output = `Task ${taskId} has been cancelled.`

  // If that was the last running task for this session, surface the same
  // "all complete" signal a normal completion would. Returning it from the tool
  // cannot silently fail, so the dedup flag is committed immediately.
  const notification = manager.getCompletionStatusForSession(sessionID)
  if (notification?.allComplete) {
    output += `\n\n${notification.message}`
    manager.markNotified(notification.completedTasks)
  }

  return output
}

export function listBackgroundTasks(manager: BackgroundManager, sessionID: string): string {
  const tasks = manager.listAllTasks().filter((t) => t.parentSessionID === sessionID)

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
}

/** Registers the background tools on a V2 tool editor. */
export function addBackgroundTools(editor: ToolEditor, manager: BackgroundManager): void {
  addZodTool(editor, {
    name: "background_task",
    permission: "background_task",
    description: `Launch a background agent task for parallel execution.
The task runs asynchronously while you continue working.
You will be notified when ALL background tasks complete.
Use for independent research tasks that benefit from parallelism.`,
    schema: z.object({
      agent: z
        .string()
        .describe("Agent to use: explorer, librarian, oracle, ui-planner, or inspector"),
      description: z
        .string()
        .describe("Short 3-5 word description for tracking (e.g., 'Find auth code')"),
      prompt: z.string().describe("Detailed instructions for the agent to execute"),
    }),
    execute: (input, context) => launchBackgroundTask(manager, input, context.sessionID),
  })

  addZodTool(editor, {
    name: "background_output",
    description: `Get the output from a completed background task.
Use this after receiving notification that tasks are complete.`,
    schema: z.object({
      task_id: z
        .string()
        .describe("Task ID from the completion notification (e.g., 'bg_abc12345')"),
    }),
    execute: (input) => manager.getOutput(input.task_id),
  })

  addZodTool(editor, {
    name: "background_cancel",
    description: `Cancel a running background task.
Use if a task is no longer needed or taking too long.`,
    schema: z.object({
      task_id: z.string().describe("Task ID to cancel"),
    }),
    execute: (input, context) => cancelBackgroundTask(manager, input.task_id, context.sessionID),
  })

  addZodTool(editor, {
    name: "background_list",
    description: `List background tasks launched by this session with their status.
Use to check what is running, or to recover task IDs if a completion notification was lost.`,
    schema: z.object({}),
    execute: (_input, context) => listBackgroundTasks(manager, context.sessionID),
  })
}
