/**
 * Background Task System
 *
 * Provides parallel agent execution via fire-and-forget background sessions.
 */

export { BackgroundManager } from "./manager"
export { createBackgroundTools, type BackgroundTools } from "./tools"
export type {
  BackgroundTask,
  TaskStatus,
  LaunchInput,
  CompletionNotification,
} from "./types"
