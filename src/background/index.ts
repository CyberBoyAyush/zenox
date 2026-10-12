/**
 * Background Task System
 *
 * Provides parallel agent execution via fire-and-forget child sessions.
 */

export {
  BackgroundManager,
  BackgroundLimitError,
  DEFAULT_BACKGROUND_LIMITS,
  type BackgroundLimits,
} from "./manager"
export {
  addBackgroundTools,
  launchBackgroundTask,
  cancelBackgroundTask,
  listBackgroundTasks,
} from "./tools"
export type {
  BackgroundTask,
  BackgroundSessionHost,
  SessionMessageText,
  TaskStatus,
  LaunchInput,
  CompletionNotification,
} from "./types"
