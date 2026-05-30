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

/** Hard ceiling on retained tasks to prevent unbounded memory growth. */
const MAX_RETAINED_TASKS = 100

export interface BackgroundLimits {
  /** Max simultaneously running tasks across all sessions. */
  maxConcurrent: number
  /** Max total tasks a single parent session may spawn (runaway circuit breaker). */
  maxPerSession: number
}

export const DEFAULT_BACKGROUND_LIMITS: BackgroundLimits = {
  maxConcurrent: 6,
  maxPerSession: 50,
}

/** Thrown by launch() when a concurrency/circuit-breaker limit is hit. */
export class BackgroundLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BackgroundLimitError"
  }
}

/** Notifies the parent session when a background task completes or fails. */
export type CompletionNotifier = (notification: CompletionNotification) => void

export class BackgroundManager {
  private tasks = new Map<string, BackgroundTask>()
  private mainSessionID: string | undefined
  private toastManager: TaskToastManager | undefined
  private completionNotifier: CompletionNotifier | undefined
  /** Parent sessions that were deleted; their task completions are silenced. */
  private detachedParentSessions = new Set<string>()
  private limits: BackgroundLimits = DEFAULT_BACKGROUND_LIMITS
  /** Total tasks ever launched per parent session (for the lifetime circuit breaker). */
  private spawnCounts = new Map<string, number>()
  /**
   * Slots reserved synchronously at launch() entry, before the async
   * session.create resolves. Counted toward concurrency so a burst of parallel
   * launches cannot all pass checkLaunchAllowed and overshoot the cap (TOCTOU).
   */
  private reserved = 0
  /** Set once dispose() runs; guards against in-flight launches mutating state. */
  private disposed = false

  setLimits(limits: Partial<BackgroundLimits> | undefined): void {
    if (!limits) return
    this.limits = {
      maxConcurrent: limits.maxConcurrent ?? this.limits.maxConcurrent,
      maxPerSession: limits.maxPerSession ?? this.limits.maxPerSession,
    }
  }

  getLimits(): BackgroundLimits {
    return this.limits
  }

  /**
   * Authoritative, synchronous admission check. Returns null if a launch is
   * allowed right now, or a human-readable rejection reason. Counts in-flight
   * reservations so concurrent launches can't collectively overshoot the cap.
   *
   * NOTE: this is the single source of truth, also called inside launch() in
   * the same synchronous critical section as the reservation increment, so the
   * check and the reserve are atomic (no TOCTOU gap).
   */
  checkLaunchAllowed(parentSessionID: string): string | null {
    const inUse = this.listActiveTasks().length + this.reserved
    if (inUse >= this.limits.maxConcurrent) {
      return `Concurrency limit reached: ${inUse} background task(s) already running (max ${this.limits.maxConcurrent}). Wait for tasks to finish and call background_output to collect their results before launching more.`
    }
    const spawned = this.spawnCounts.get(parentSessionID) ?? 0
    if (spawned >= this.limits.maxPerSession) {
      return `Background task circuit breaker reached: this session has launched ${spawned} background tasks (max ${this.limits.maxPerSession}). Continue manually or start a new session if this was intentional.`
    }
    return null
  }

  setToastManager(manager: TaskToastManager): void {
    this.toastManager = manager
  }

  /**
   * Register a callback used to push a completion/failure notification to the
   * owning parent session (e.g. when a task fails to start, since that path is
   * not driven by a session.idle event).
   */
  setCompletionNotifier(notifier: CompletionNotifier): void {
    this.completionNotifier = notifier
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
    // Atomic admission: check the limit AND reserve the slot in the same
    // synchronous step (no await between them) so simultaneous launches cannot
    // collectively overshoot maxConcurrent. This is the authoritative gate.
    const rejection = this.checkLaunchAllowed(input.parentSessionID)
    if (rejection) {
      throw new BackgroundLimitError(rejection)
    }
    this.reserved++
    let reservationHeld = true
    const releaseReservation = () => {
      if (reservationHeld) {
        reservationHeld = false
        this.reserved = Math.max(0, this.reserved - 1)
      }
    }

    try {
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

      // If the manager was disposed while session.create was in flight, abort
      // without mutating state or starting the prompt.
      if (this.disposed) {
        throw new Error("Background manager disposed")
      }

      // Create task record
      const task: BackgroundTask = {
        id: this.generateTaskId(),
        sessionID,
        parentSessionID: input.parentSessionID,
        agent: input.agent,
        description: input.description,
        prompt: input.prompt,
        status: "running",
        startedAt: new Date(),
        parentAgent: input.parentAgent,
        parentModel: input.parentModel,
      }

      this.tasks.set(task.id, task)
      // Task is now visible in tasks (counts as running) - release the reservation
      // so we don't double-count it against the concurrency cap.
      releaseReservation()

      // Track lifetime spawn count for this parent session (circuit breaker)
      this.spawnCounts.set(
        input.parentSessionID,
        (this.spawnCounts.get(input.parentSessionID) ?? 0) + 1
      )

      // Bound memory: trim oldest finished tasks if we exceed the cap
      this.trimRetainedTasks()

      return this.continueLaunch(client, task, input)
    } catch (err) {
      releaseReservation()
      throw err
    }
  }

  /** Completes the prompt dispatch after the task record is registered. */
  private continueLaunch(
    client: OpencodeClient,
    task: BackgroundTask,
    input: LaunchInput
  ): BackgroundTask {
    const sessionID = task.sessionID

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

          // A failed launch never emits session.idle, so push a scoped
          // completion notification directly so the parent agent learns of it.
          if (!this.detachedParentSessions.has(existingTask.parentSessionID)) {
            const notification = this.getCompletionStatusForSession(
              existingTask.parentSessionID,
              existingTask
            )
            if (notification && this.completionNotifier) {
              this.completionNotifier(notification)
            }
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

    // If the parent session was deleted, keep the lifecycle silent and drop the
    // finished task so it never leaks into another session's notifications.
    if (this.detachedParentSessions.has(task.parentSessionID)) {
      this.tasks.delete(task.id)
      return null
    }

    // Show completion toast
    if (this.toastManager) {
      this.toastManager.showCompletionToast(task.id).catch(() => {})
    }

    // Generate a notification scoped to THIS task's parent session only,
    // passing the task that just finished so the partial message names it correctly.
    return this.getCompletionStatusForSession(task.parentSessionID, task)
  }

  /**
   * Build a completion notification for a single parent session. Tasks from
   * other sessions are never included, preventing cross-session bleed.
   * `justFinished` is the task that triggered this notification (so the partial
   * message names the correct task regardless of Map insertion order).
   */
  getCompletionStatusForSession(
    parentSessionID: string,
    justFinished?: BackgroundTask
  ): CompletionNotification | null {
    const sessionTasks = [...this.tasks.values()].filter(
      (t) => t.parentSessionID === parentSessionID
    )

    if (sessionTasks.length === 0) {
      return null
    }

    const runningTasks = sessionTasks.filter((t) => t.status === "running")
    const completedTasks = sessionTasks.filter(
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
      // Prefer the explicitly-passed just-finished task; otherwise fall back to
      // the most-recently-completed task by timestamp (NOT Map insertion order).
      const justCompleted =
        justFinished ??
        completedTasks.reduce<BackgroundTask | undefined>((latest, t) => {
          const tTime = t.completedAt?.getTime() ?? 0
          const lTime = latest?.completedAt?.getTime() ?? -1
          return tTime >= lTime ? t : latest
        }, undefined)
      message = `<system-reminder>
[BACKGROUND TASK COMPLETE]
Task: ${justCompleted?.id ?? "unknown"} (${justCompleted?.description ?? "unknown"})
${runningTasks.length} task(s) still running. Continue working.
</system-reminder>`
    }

    // Parent context from a completed task in THIS session (all share parent).
    const parentAgent = completedTasks[0]?.parentAgent
    const parentModel = completedTasks[0]?.parentModel

    return {
      allComplete,
      message,
      completedTasks,
      runningCount: runningTasks.length,
      parentSessionID,
      parentAgent,
      parentModel,
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

  /**
   * Mark a parent session as detached (e.g. it was deleted). Finished tasks for
   * it are dropped immediately; still-running tasks finish silently (no
   * notification) since there's no session left to notify.
   */
  detachParentSession(sessionID: string): void {
    if (!sessionID) return
    this.detachedParentSessions.add(sessionID)
    for (const [id, task] of this.tasks) {
      if (task.parentSessionID === sessionID && task.status !== "running") {
        this.tasks.delete(id)
      }
    }
  }

  /**
   * Evict the oldest finished tasks when the retained-task count exceeds the cap.
   * Running tasks are never evicted. Finished tasks whose parent session still
   * has running tasks are also preserved, so a pending "all complete" summary
   * for that session is never missing tasks.
   */
  private trimRetainedTasks(): void {
    if (this.tasks.size <= MAX_RETAINED_TASKS) return

    // Sessions that still have at least one running task -> their finished
    // tasks are needed for the eventual completion summary.
    const sessionsWithRunning = new Set<string>()
    for (const t of this.tasks.values()) {
      if (t.status === "running") sessionsWithRunning.add(t.parentSessionID)
    }

    const evictable = [...this.tasks.values()]
      .filter((t) => t.status !== "running" && !sessionsWithRunning.has(t.parentSessionID))
      .sort(
        (a, b) =>
          (a.completedAt?.getTime() ?? a.startedAt.getTime()) -
          (b.completedAt?.getTime() ?? b.startedAt.getTime())
      )

    let overflow = this.tasks.size - MAX_RETAINED_TASKS
    for (const task of evictable) {
      if (overflow <= 0) break
      this.tasks.delete(task.id)
      overflow--
    }
  }

  /**
   * Release all in-memory state. Called from the plugin `dispose` hook on teardown.
   */
  dispose(): void {
    this.disposed = true
    this.tasks.clear()
    this.spawnCounts.clear()
    this.detachedParentSessions.clear()
    this.reserved = 0
    this.mainSessionID = undefined
  }
}
