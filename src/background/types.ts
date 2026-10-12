/**
 * Background Task System Types
 * Minimal interfaces for fire-and-forget parallel agent execution
 */

export type TaskStatus = "running" | "completed" | "failed" | "cancelled"

export interface BackgroundTask {
  id: string
  sessionID: string
  parentSessionID: string // Session that launched this task (for scoped notifications)
  agent: string
  description: string
  prompt: string
  status: TaskStatus
  startedAt: Date
  completedAt?: Date
  error?: string
  /** True once this finished task has been included in an "ALL COMPLETE" notification. */
  notified?: boolean
  /**
   * True from the moment this task is claimed into a batch by
   * getCompletionStatusForSession until the caller confirms delivery
   * (markNotified) or reports failure (releaseClaim). Prevents a second
   * concurrent caller from claiming the same task while the first caller's
   * delivery is still in flight, and doubles as the "notification currently
   * being delivered" signal for hasActiveBackgroundWork.
   */
  claiming?: boolean
}

export interface LaunchInput {
  agent: string
  prompt: string
  description: string
  parentSessionID: string
}

export interface CompletionNotification {
  allComplete: boolean
  message: string
  completedTasks: BackgroundTask[]
  runningCount: number
  parentSessionID: string // Session that owns these tasks (notification target)
}

/** Message text the manager reads back from a finished child session. */
export interface SessionMessageText {
  role: "assistant" | "other"
  /** Text parts of the message, in order. */
  texts: string[]
}

/**
 * The only OpenCode operations the background system needs. Implemented by the
 * V2 host (src/host/v2.ts); tests provide an in-memory fake.
 */
export interface BackgroundSessionHost {
  /** Create a child session of `parentSessionID` running `agent` (when given). Returns its ID. */
  createChildSession(input: {
    parentSessionID: string
    agent?: string
    title: string
  }): Promise<string>
  /** Send the task prompt into a child session and start its agent loop. */
  prompt(sessionID: string, text: string): Promise<void>
  /**
   * Resolve once the child's agent loop has finished. `isActive` turns false
   * when the task was cancelled/timed out, so the wait can stop early.
   */
  waitForCompletion(sessionID: string, isActive: () => boolean): Promise<void>
  /** Stop a session's active execution. */
  interrupt(sessionID: string): Promise<void>
  /** Read a session's messages, oldest first. */
  readMessages(sessionID: string): Promise<SessionMessageText[]>
}
