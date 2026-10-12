/**
 * Task Toast Manager
 *
 * Manages toast notifications for background tasks:
 * - Shows toast when task is launched
 * - Shows toast when task completes
 * - Shows summary toast when all tasks complete
 */

import type { ToastSink } from "../../shared/toast"

interface TrackedTask {
  id: string
  description: string
  agent: string
  startedAt: Date
  status: "running" | "completed" | "failed"
}

const LAUNCH_TOAST_DURATION = 3000
const COMPLETE_TOAST_DURATION = 4000
const ALL_COMPLETE_TOAST_DURATION = 5000

function formatDuration(startedAt: Date): string {
  const seconds = Math.floor((Date.now() - startedAt.getTime()) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

export class TaskToastManager {
  private tasks = new Map<string, TrackedTask>()
  private sink: ToastSink

  constructor(sink: ToastSink) {
    this.sink = sink
  }

  async showLaunchToast(task: {
    id: string
    description: string
    agent: string
  }): Promise<void> {
    // Track the task
    this.tasks.set(task.id, {
      ...task,
      startedAt: new Date(),
      status: "running",
    })

    const runningCount = this.getRunningCount()
    const message = runningCount > 1
      ? `"${task.description}"\nAgent: ${task.agent}\nRunning: ${runningCount}`
      : `"${task.description}"\nAgent: ${task.agent}`

    this.sink({
      title: "⚡ Background Task Launched",
      message,
      variant: "info",
      duration: LAUNCH_TOAST_DURATION,
        })
  }

  async showCompletionToast(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return

    task.status = "completed"
    const duration = formatDuration(task.startedAt)
    const runningCount = this.getRunningCount()

    // Check if all tasks are complete
    if (runningCount === 0) {
      await this.showAllCompleteToast()
      return
    }

    const message = `"${task.description}" (${duration})\nStill running: ${runningCount}`

    this.sink({
      title: "✅ Task Completed",
      message,
      variant: "success",
      duration: COMPLETE_TOAST_DURATION,
        })
  }

  async showFailureToast(taskId: string, error?: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return

    task.status = "failed"
    const duration = formatDuration(task.startedAt)

    const message = error
      ? `"${task.description}" (${duration})\nError: ${error}`
      : `"${task.description}" (${duration})`

    this.sink({
      title: "❌ Task Failed",
      message,
      variant: "error",
      duration: COMPLETE_TOAST_DURATION,
        })
  }

  private async showAllCompleteToast(): Promise<void> {
    const completedTasks = [...this.tasks.values()].filter(
      (t) => t.status === "completed" || t.status === "failed"
    )

    const taskList = completedTasks
      .map((t) => {
        const icon = t.status === "completed" ? "✓" : "✗"
        const duration = formatDuration(t.startedAt)
        return `${icon} ${t.description} (${duration})`
      })
      .join("\n")

    this.sink({
      title: "🎉 All Background Tasks Complete",
      message: `${taskList}\n\nUse background_output to retrieve.`,
      variant: "success",
      duration: ALL_COMPLETE_TOAST_DURATION,
        })

    // Clear completed tasks after showing summary
    this.clearCompleted()
  }

  private getRunningCount(): number {
    return [...this.tasks.values()].filter((t) => t.status === "running").length
  }

  private clearCompleted(): void {
    for (const [id, task] of this.tasks) {
      if (task.status !== "running") {
        this.tasks.delete(id)
      }
    }
  }

  trackTask(task: { id: string; description: string; agent: string }): void {
    this.tasks.set(task.id, {
      ...task,
      startedAt: new Date(),
      status: "running",
    })
  }

  getTask(taskId: string): TrackedTask | undefined {
    return this.tasks.get(taskId)
  }
}
