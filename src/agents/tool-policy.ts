/**
 * Shared permission policy for Zenox subagents (OpenCode V2 ordered rules).
 *
 * V2 tools are allowed by default, so agents restrict themselves with explicit
 * deny rules. `edit` covers V1's write/edit/patch, `shell` replaces `bash`, and
 * `subagent` replaces `task`. `background_task` is denied so a subagent can never
 * fan out its own background work (Zenox's recursion guard).
 */

import type { PermissionRule } from "./types"

export const deny = (action: string): PermissionRule => ({ action, resource: "*", effect: "deny" })

/** Prevents subagents from launching more agents, natively or via Zenox. */
export const NO_RECURSION_PERMISSIONS: readonly PermissionRule[] = [
  deny("subagent"),
  deny("background_task"),
]

/** Read-only: no edits, no shell, no recursion. */
export const READ_ONLY_PERMISSIONS: readonly PermissionRule[] = [
  deny("edit"),
  deny("shell"),
  ...NO_RECURSION_PERMISSIONS,
]
