/**
 * Session-Agent Tracker
 * 
 * Tracks which agent is active for each session, allowing the system transform
 * hook to inject agent-specific prompts.
 * 
 * Flow:
 * 1. chat.message hook fires with { sessionID, agent }
 * 2. We store the mapping: sessionID -> agentName
 * 3. experimental.chat.system.transform fires with { sessionID }
 * 4. We look up the agent and inject the appropriate prompt
 */

/** Map of sessionID to agent name */
const sessionAgentMap = new Map<string, string>()

/**
 * Record which agent is active for a session.
 * Called from chat.message hook.
 */
export function setSessionAgent(sessionID: string, agent: string | undefined): void {
  if (agent) {
    sessionAgentMap.set(sessionID, agent)
  }
}

/**
 * Get the active agent for a session.
 * Called from experimental.chat.system.transform hook.
 */
export function getSessionAgent(sessionID: string): string | undefined {
  return sessionAgentMap.get(sessionID)
}

/**
 * Clear tracking for a session (on deletion).
 */
export function clearSessionAgent(sessionID: string | undefined): void {
  if (sessionID) {
    sessionAgentMap.delete(sessionID)
  }
}

/**
 * Check if an agent should receive orchestration injection.
 * Only build and plan agents get the orchestration prompt.
 */
export function shouldInjectOrchestration(agent: string | undefined): boolean {
  if (!agent) return false
  return agent === "build" || agent === "plan"
}

/**
 * Get the agent type for prompt selection.
 * Returns "build", "plan", or string for other agents.
 */
export function getOrchestrationAgentType(agent: string | undefined): "build" | "plan" | string | undefined {
  if (agent === "build") return "build"
  if (agent === "plan") return "plan"
  if (agent === undefined) return undefined
  return agent
}
