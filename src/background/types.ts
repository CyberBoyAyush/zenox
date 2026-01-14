/**
 * Background Task System Types
 * Minimal interfaces for fire-and-forget parallel agent execution
 */

export type TaskStatus = "running" | "completed" | "failed" | "cancelled"

export interface BackgroundTask {
  id: string
  sessionID: string
  agent: string
  description: string
  prompt: string
  status: TaskStatus
  startedAt: Date
  completedAt?: Date
  error?: string
  parentAgent?: string // Agent that was active when task was launched (plan/build)
}

export interface LaunchInput {
  agent: string
  prompt: string
  description: string
  parentSessionID: string
  parentAgent?: string // Agent that was active when task was launched (plan/build)
}

export interface CompletionNotification {
  allComplete: boolean
  message: string
  completedTasks: BackgroundTask[]
  runningCount: number
  parentAgent?: string // Agent to return notification to (preserves mode)
}
