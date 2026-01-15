/**
 * BackgroundManager - Minimal background task orchestration
 *
 * Handles:
 * - Launching background agent sessions (fire-and-forget)
 * - Tracking task status
 * - Detecting completion via session.idle events
 * - Generating completion notifications
 */

import type { OpencodeClient } from "@opencode-ai/sdk"
import type {
  BackgroundTask,
  LaunchInput,
  CompletionNotification,
} from "./types"
import type { TaskToastManager } from "../features/task-toast"

export class BackgroundManager {
  private tasks = new Map<string, BackgroundTask>()
  private mainSessionID: string | undefined
  private toastManager: TaskToastManager | undefined

  setToastManager(manager: TaskToastManager): void {
    this.toastManager = manager
  }

  setMainSession(sessionID: string | undefined): void {
    this.mainSessionID = sessionID
  }

  getMainSession(): string | undefined {
    return this.mainSessionID
  }

  private generateTaskId(): string {
    return `bg_${crypto.randomUUID().slice(0, 8)}`
  }

  async launch(
    client: OpencodeClient,
    input: LaunchInput
  ): Promise<BackgroundTask> {
    // Store main session ID for notifications
    if (!this.mainSessionID) {
      this.mainSessionID = input.parentSessionID
    }

    // Create child session
    const createResult = await client.session.create({
      body: {
        parentID: input.parentSessionID,
      },
    })

    // Handle SDK response structure
    const sessionData = "data" in createResult ? createResult.data : createResult
    const sessionID = sessionData?.id

    if (!sessionID) {
      throw new Error("Failed to create background session")
    }

    // Create task record
    const task: BackgroundTask = {
      id: this.generateTaskId(),
      sessionID,
      agent: input.agent,
      description: input.description,
      prompt: input.prompt,
      status: "running",
      startedAt: new Date(),
      parentAgent: input.parentAgent,
    }

    this.tasks.set(task.id, task)

    // Show launch toast
    if (this.toastManager) {
      this.toastManager.showLaunchToast({
        id: task.id,
        description: task.description,
        agent: task.agent,
      }).catch(() => {})
    }

    // Fire-and-forget: send prompt without awaiting result
    // Includes retry logic for agent.name undefined errors
    const sendPrompt = async (retryWithoutAgent = false) => {
      try {
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            // On retry, omit agent to use default
            ...(retryWithoutAgent ? {} : { agent: input.agent }),
            tools: { task: false }, // Prevent recursive background tasks
            parts: [{ type: "text", text: input.prompt }],
          },
        })
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err)

        // Detect the specific agent.name undefined error and retry without agent
        if (
          !retryWithoutAgent &&
          (errorMsg.includes("agent.name") || errorMsg.includes("undefined is not an object"))
        ) {
          console.warn(`[zenox] Agent "${input.agent}" not found. Retrying with default agent.`)
          return sendPrompt(true)
        }

        // Handle other errors
        const existingTask = this.tasks.get(task.id)
        if (existingTask) {
          existingTask.status = "failed"
          existingTask.error = errorMsg
          existingTask.completedAt = new Date()

          // Show failure toast
          if (this.toastManager) {
            this.toastManager.showFailureToast(task.id, existingTask.error).catch(() => {})
          }
        }
      }
    }

    sendPrompt().catch(() => {})

    return task
  }

  getTask(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId)
  }

  findTaskBySessionID(sessionID: string): BackgroundTask | undefined {
    for (const task of this.tasks.values()) {
      if (task.sessionID === sessionID) {
        return task
      }
    }
    return undefined
  }

  async getOutput(
    client: OpencodeClient,
    taskId: string
  ): Promise<string | undefined> {
    const task = this.tasks.get(taskId)
    if (!task) {
      return `Task ${taskId} not found`
    }

    if (task.status === "running") {
      return `Task ${taskId} is still running`
    }

    if (task.status === "failed") {
      return `Task ${taskId} failed: ${task.error ?? "Unknown error"}`
    }

    if (task.status === "cancelled") {
      return `Task ${taskId} was cancelled`
    }

    // Read messages from the background session
    try {
      const messagesResult = await client.session.messages({
        path: { id: task.sessionID },
      })

      // Handle SDK response structure
      const messages =
        "data" in messagesResult ? messagesResult.data : messagesResult

      if (!messages || !Array.isArray(messages)) {
        return `Task ${taskId} completed but could not retrieve messages`
      }

      // Messages are { info: Message, parts: Part[] } objects
      interface MessageWrapper {
        info: {
          role: string
        }
        parts: Array<{
          type: string
          text?: string
        }>
      }

      const assistantMessages = (messages as MessageWrapper[]).filter(
        (m) => m.info.role === "assistant" && m.parts && m.parts.length > 0
      )

      if (assistantMessages.length === 0) {
        return `Task ${taskId} completed but no output found`
      }

      const lastMessage = assistantMessages[assistantMessages.length - 1]

      // Extract text content from message parts
      const textParts = lastMessage.parts.filter((p) => p.type === "text")
      const output = textParts.map((p) => p.text ?? "").join("\n")

      return output || `Task ${taskId} completed but output was empty`
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error"
      return `Failed to retrieve output for ${taskId}: ${errorMsg}`
    }
  }

  async cancel(client: OpencodeClient, taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== "running") {
      return false
    }

    try {
      await client.session.abort({ path: { id: task.sessionID } })
      task.status = "cancelled"
      task.completedAt = new Date()
      return true
    } catch {
      return false
    }
  }

  // Called when session.idle event is received
  handleSessionIdle(sessionID: string): CompletionNotification | null {
    const task = this.findTaskBySessionID(sessionID)

    // Not one of our background tasks
    if (!task || task.status !== "running") {
      return null
    }

    // Mark task as complete
    task.status = "completed"
    task.completedAt = new Date()

    // Show completion toast
    if (this.toastManager) {
      this.toastManager.showCompletionToast(task.id).catch(() => {})
    }

    // Generate notification
    return this.getCompletionStatus()
  }

  getCompletionStatus(): CompletionNotification {
    const allTasks = [...this.tasks.values()]
    const runningTasks = allTasks.filter((t) => t.status === "running")
    const completedTasks = allTasks.filter(
      (t) => t.status === "completed" || t.status === "failed"
    )

    const allComplete = runningTasks.length === 0 && completedTasks.length > 0

    let message: string
    if (allComplete) {
      const taskList = completedTasks
        .map((t) => `- ${t.id}: ${t.description} (${t.agent})`)
        .join("\n")

      message = `<system-reminder>
[ALL BACKGROUND TASKS COMPLETE]

**Completed:**
${taskList}

Use \`background_output(task_id="<id>")\` to retrieve each result and synthesize findings.
</system-reminder>`
    } else {
      const justCompleted = completedTasks[completedTasks.length - 1]
      message = `<system-reminder>
[BACKGROUND TASK COMPLETE]
Task: ${justCompleted?.id ?? "unknown"} (${justCompleted?.description ?? "unknown"})
${runningTasks.length} task(s) still running. Continue working.
</system-reminder>`
    }

    // Get parentAgent from the first completed task (all tasks share same parent)
    const parentAgent = completedTasks[0]?.parentAgent

    return {
      allComplete,
      message,
      completedTasks,
      runningCount: runningTasks.length,
      parentAgent,
    }
  }

  listActiveTasks(): BackgroundTask[] {
    return [...this.tasks.values()].filter((t) => t.status === "running")
  }

  listAllTasks(): BackgroundTask[] {
    return [...this.tasks.values()]
  }

  clearCompleted(): void {
    for (const [id, task] of this.tasks) {
      if (task.status !== "running") {
        this.tasks.delete(id)
      }
    }
  }
}
