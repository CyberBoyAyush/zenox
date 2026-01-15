/**
 * First Message Variant Gate
 *
 * Tracks new sessions to apply variants only on the first message.
 * Prevents variants from being applied to forked/child sessions.
 */

type SessionInfo = {
  id?: string
  parentID?: string
}

/**
 * Creates a gate that tracks which sessions need variant applied on first message
 */
export function createFirstMessageVariantGate() {
  const pending = new Set<string>()

  return {
    /**
     * Mark a newly created session as pending variant application
     * Only marks non-child sessions (no parentID)
     */
    markSessionCreated(info?: SessionInfo): void {
      if (info?.id && !info.parentID) {
        pending.add(info.id)
      }
    },

    /**
     * Check if this session should have variant overridden
     */
    shouldOverride(sessionID?: string): boolean {
      if (!sessionID) return false
      return pending.has(sessionID)
    },

    /**
     * Mark variant as applied for this session
     */
    markApplied(sessionID?: string): void {
      if (!sessionID) return
      pending.delete(sessionID)
    },

    /**
     * Clear session from tracking (on session delete)
     */
    clear(sessionID?: string): void {
      if (!sessionID) return
      pending.delete(sessionID)
    },
  }
}

export type FirstMessageVariantGate = ReturnType<typeof createFirstMessageVariantGate>
