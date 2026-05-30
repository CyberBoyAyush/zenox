/**
 * Background Task System
 *
 * Provides parallel agent execution via fire-and-forget background sessions.
 */

export {
  BackgroundManager,
  BackgroundLimitError,
  DEFAULT_BACKGROUND_LIMITS,
  type BackgroundLimits,
} from "./manager"
export { createBackgroundTools, type BackgroundTools } from "./tools"
export type {
  BackgroundTask,
  TaskStatus,
  LaunchInput,
  CompletionNotification,
  ParentModel,
} from "./types"
