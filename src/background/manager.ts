/**
 * BackgroundManager - Minimal background task orchestration
 *
 * Handles:
 * - Launching background agent sessions (fire-and-forget)
 * - Tracking task status
 * - Detecting completion via session.idle events
 * - Generating completion notifications
 */

import type {
  BackgroundTask,
  BackgroundSessionHost,
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
  /**
   * Wall-clock timeout per task. A task whose child session never goes idle
   * would otherwise hold a concurrency slot forever; on timeout it is
   * aborted and marked failed.
   */
  taskTimeoutMs: number
}

export const DEFAULT_BACKGROUND_LIMITS: BackgroundLimits = {
  maxConcurrent: 6,
  maxPerSession: 50,
  taskTimeoutMs: 30 * 60_000,
}

const TERMINAL_STATUSES = new Set<BackgroundTask["status"]>([
  "completed",
  "failed",
  "cancelled",
])

function isFinished(task: BackgroundTask): boolean {
  return TERMINAL_STATUSES.has(task.status)
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
  constructor(private readonly host: BackgroundSessionHost) {}

  private tasks = new Map<string, BackgroundTask>()
  private toastManager: TaskToastManager | undefined
  private completionNotifier: CompletionNotifier | undefined
  private childIdleListener: ((sessionID: string) => void) | undefined
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
  /** Per-task timeout timers, cleared on completion/cancel/dispose. */
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>()

  setLimits(limits: Partial<BackgroundLimits> | undefined): void {
    if (!limits) return
    this.limits = {
      maxConcurrent: limits.maxConcurrent ?? this.limits.maxConcurrent,
      maxPerSession: limits.maxPerSession ?? this.limits.maxPerSession,
      taskTimeoutMs: limits.taskTimeoutMs ?? this.limits.taskTimeoutMs,
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

  private generateTaskId(): string {
    return `bg_${crypto.randomUUID().slice(0, 8)}`
  }

  private clearTaskTimeout(taskId: string): void {
    const timer = this.timeouts.get(taskId)
    if (timer) {
      clearTimeout(timer)
      this.timeouts.delete(taskId)
    }
  }

  /** Marks a task failed, shows the toast, and notifies the parent (unless detached). */
  private failTask(task: BackgroundTask, error: string): void {
    task.status = "failed"
    task.error = error
    task.completedAt = new Date()
    this.clearTaskTimeout(task.id)

    if (this.detachedParentSessions.has(task.parentSessionID)) return

    if (this.toastManager) {
      this.toastManager.showFailureToast(task.id, error).catch(() => {})
    }

    // A failure never emits session.idle, so push a scoped completion
    // notification directly so the parent agent learns of it.
    const notification = this.getCompletionStatusForSession(
      task.parentSessionID,
      task
    )
    if (notification) {
      if (this.completionNotifier) {
        this.completionNotifier(notification)
      } else {
        // Nobody is registered to attempt delivery — release the claim
        // immediately instead of leaving these tasks stuck "claiming"
        // forever (which would also wedge hasActiveBackgroundWork "on").
        this.releaseClaim(notification.completedTasks)
      }
    }
  }

  /**
   * Aborts and fails the task if it is still running when the timeout fires.
   * The abort call is fire-and-forget (not awaited) deliberately: this is the
   * safety net for a session that is already unresponsive, so blocking on its
   * abort() would defeat the point of having a timeout at all.
   */
  private scheduleTaskTimeout(task: BackgroundTask): void {
    const timeoutMs = this.limits.taskTimeoutMs
    const timer = setTimeout(() => {
      this.timeouts.delete(task.id)
      const current = this.tasks.get(task.id)
      if (!current || current.status !== "running") return
      this.host.interrupt(current.sessionID).catch(() => {})
      this.failTask(
        current,
        `Timed out after ${Math.round(timeoutMs / 60_000)} minutes and was aborted`
      )
    }, timeoutMs)
    // A pending timeout must not hold the process open.
    ;(timer as { unref?: () => void }).unref?.()
    this.timeouts.set(task.id, timer)
  }

  async launch(input: LaunchInput): Promise<BackgroundTask> {
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
      const sessionID = await this.createChildSession(input)

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

      return this.continueLaunch(task, input)
    } catch (err) {
      releaseReservation()
      throw err
    }
  }

  /** Completes the prompt dispatch after the task record is registered. */
  private continueLaunch(task: BackgroundTask, input: LaunchInput): BackgroundTask {
    const sessionID = task.sessionID

    // Show launch toast
    if (this.toastManager) {
      this.toastManager.showLaunchToast({
        id: task.id,
        description: task.description,
        agent: task.agent,
      }).catch(() => {})
    }

    // Schedule the wall-clock timeout so a task whose child session never
    // goes idle cannot hold a concurrency slot forever.
    this.scheduleTaskTimeout(task)

    // Fire-and-forget: the child runs while the parent keeps working. Completion
    // is detected by waiting on the child session directly (V2 plugin event
    // delivery is not reliable — anomalyco/opencode#44788); a session.idle
    // event, if delivered, is handled the same way and is idempotent.
    const isRunning = () => this.tasks.get(task.id)?.status === "running"
    this.host.prompt(sessionID, input.prompt).then(
      () =>
        this.host
          .waitForCompletion(sessionID, isRunning)
          .then(() => {
            if (isRunning()) this.childIdleListener?.(sessionID)
          })
          .catch(() => {
            // Waiting failed; the task timeout (or a session.idle event) settles it.
          }),
      (err: unknown) => {
        const existingTask = this.tasks.get(task.id)
        if (existingTask && existingTask.status === "running") {
          this.failTask(existingTask, err instanceof Error ? err.message : String(err))
        }
      }
    )

    return task
  }

  /**
   * Create the child session for a task. Fails closed if the agent is rejected:
   * silently falling back to the default agent would run the task without the
   * subagent's read-only restrictions and system prompt.
   */
  private createChildSession(input: LaunchInput): Promise<string> {
    return this.host.createChildSession({
      parentSessionID: input.parentSessionID,
      agent: input.agent,
      title: `${input.description} (@${input.agent} background)`,
    })
  }

  /** Called when a child session finishes; the plugin routes it like a session.idle. */
  setChildIdleListener(listener: (sessionID: string) => void): void {
    this.childIdleListener = listener
  }

  /** True if `sessionID` is a background child session (running or retained). */
  isBackgroundSession(sessionID: string): boolean {
    return this.findTaskBySessionID(sessionID) !== undefined
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

  async getOutput(taskId: string): Promise<string> {
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

    try {
      const messages = await this.host.readMessages(task.sessionID)
      const assistantMessages = messages.filter(
        (m) => m.role === "assistant" && m.texts.length > 0
      )

      if (assistantMessages.length === 0) {
        return `Task ${taskId} completed but no output found`
      }

      const output = assistantMessages[assistantMessages.length - 1].texts.join("\n")
      return output || `Task ${taskId} completed but output was empty`
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error"
      return `Failed to retrieve output for ${taskId}: ${errorMsg}`
    }
  }

  async cancel(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== "running") {
      return false
    }

    // Status flips BEFORE the await: aborting emits session.idle for the
    // child, which would otherwise be seen while the task is still "running"
    // and get misread by handleSessionIdle as a clean completion.
    //
    // Trade-off, accepted deliberately: this frees the concurrency slot
    // slightly before the child session has actually torn down server-side
    // (abort() is normally near-instant, so the window is small). The
    // alternative — flipping status only after abort() resolves — is worse:
    // it leaves the task "running" (holding its slot) indefinitely if
    // abort() ever hangs or rejects, which is exactly the failure mode the
    // task timeout below exists to guard against.
    task.status = "cancelled"
    task.completedAt = new Date()
    this.clearTaskTimeout(task.id)

    try {
      await this.host.interrupt(task.sessionID)
    } catch {
      // Already gone server-side; the task is cancelled either way.
    }

    return true
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
    this.clearTaskTimeout(task.id)

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
   *
   * The all-complete batch is claimed synchronously (see `claiming` on
   * BackgroundTask) before this function returns: a second caller racing in
   * before the first caller's delivery resolves will not see the same tasks.
   * The caller must confirm with markNotified() on success or releaseClaim()
   * on failure — never both, never neither.
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
    // Only tasks not yet included in a prior notification, and not currently
    // claimed by another in-flight delivery attempt — otherwise two racing
    // callers could both grab the same batch, or calling this twice after
    // all-complete would re-send the same "ALL COMPLETE" task list.
    const completedTasks = sessionTasks.filter(
      (t) => isFinished(t) && !t.notified && !t.claiming
    )

    if (completedTasks.length === 0) {
      return null
    }

    const allComplete = runningTasks.length === 0

    let message: string
    if (allComplete) {
      // Claim synchronously, before any caller can await anything. A second
      // concurrent call will exclude these via the `!t.claiming` filter above.
      for (const t of completedTasks) {
        t.claiming = true
      }

      // Annotate anything that did not finish cleanly. Cancelled and failed
      // tasks have no results worth fetching, and listing them bare under
      // "Completed" sends the agent off to retrieve an aborted session.
      const taskList = completedTasks
        .map((t) => {
          const suffix = t.status === "completed" ? "" : ` — ${t.status}`
          return `- ${t.id}: ${t.description} (${t.agent})${suffix}`
        })
        .join("\n")

      const retrievable = completedTasks.some((t) => t.status === "completed")
      const retrieveLine = retrievable
        ? `\n\nUse \`background_output(task_id="<id>")\` to retrieve each completed result and synthesize findings.`
        : `\n\nNothing produced output. Handle this work yourself rather than retrying the same fan-out.`

      message = `<system-reminder>
[ALL BACKGROUND TASKS COMPLETE]

**Finished:**
${taskList}${retrieveLine}
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

    return {
      allComplete,
      message,
      completedTasks,
      runningCount: runningTasks.length,
      parentSessionID,
    }
  }

  listActiveTasks(): BackgroundTask[] {
    return [...this.tasks.values()].filter((t) => t.status === "running")
  }

  /**
   * True if this session has a background task running, or a completion
   * notification for it is currently being claimed/delivered. State-based
   * (running || claiming), never time-based.
   */
  hasActiveBackgroundWork(parentSessionID: string): boolean {
    for (const task of this.tasks.values()) {
      if (task.parentSessionID !== parentSessionID) continue
      if (task.status === "running" || task.claiming) return true
    }
    return false
  }

  /**
   * Commits the notified-dedup flag and releases the claim. Deliberately
   * separate from getCompletionStatusForSession: marking inside that getter
   * burned the one-shot before delivery was known to have succeeded, so a
   * dropped notification (e.g. session.prompt failing) meant results were
   * never announced and never retried. Callers mark only after a confirmed
   * successful send, which restores retry on the next idle.
   */
  markNotified(tasks: readonly BackgroundTask[]): void {
    for (const task of tasks) {
      const existing = this.tasks.get(task.id)
      if (existing) {
        existing.notified = true
        existing.claiming = false
      }
    }
  }

  /**
   * Releases the claim without marking notified, restoring the tasks to
   * getCompletionStatusForSession's next caller. Callers invoke this when a
   * delivery attempt fails (or when nobody is registered to attempt one at
   * all), so the batch isn't stuck "claiming" forever — which would also wedge
   * hasActiveBackgroundWork permanently "on" for that session.
   */
  releaseClaim(tasks: readonly BackgroundTask[]): void {
    for (const task of tasks) {
      const existing = this.tasks.get(task.id)
      if (existing) existing.claiming = false
    }
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
   * it are dropped immediately. With abortRunning, still-running tasks are also
   * aborted — nobody is left to read their results, so letting them keep
   * running just burns tokens. Otherwise they finish silently (the
   * detached set suppresses their notifications).
   *
   * The abort is fire-and-forget and the task is dropped from bookkeeping
   * immediately rather than waiting for it to settle: the parent session is
   * gone either way, so there is nothing left to keep a concurrency slot for.
   * If abort() silently fails, the child keeps running unobserved — the same
   * outcome as calling this without abortRunning, so this path is never worse
   * than the prior (no-abort) behavior, only sometimes better.
   */
  detachParentSession(sessionID: string, abortRunning = true): void {
    if (!sessionID) return
    this.detachedParentSessions.add(sessionID)
    for (const [id, task] of this.tasks) {
      if (task.parentSessionID !== sessionID) continue
      if (task.status === "running") {
        if (abortRunning) {
          this.host.interrupt(task.sessionID).catch(() => {})
          task.status = "cancelled"
          task.completedAt = new Date()
          this.clearTaskTimeout(id)
          this.tasks.delete(id)
        }
      } else {
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
    for (const timer of this.timeouts.values()) {
      clearTimeout(timer)
    }
    this.timeouts.clear()
    this.tasks.clear()
    this.spawnCounts.clear()
    this.detachedParentSessions.clear()
    this.reserved = 0
  }
}
