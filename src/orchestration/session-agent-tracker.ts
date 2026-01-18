/**
 * Session Context Tracker
 * 
 * Tracks agent and model context for each session, allowing:
 * - System transform hook to inject agent-specific prompts
 * - Todo enforcer and background tasks to preserve model context
 * 
 * Flow:
 * 1. chat.message hook fires with { sessionID, agent, model }
 * 2. We store the mapping: sessionID -> { agent, model }
 * 3. experimental.chat.system.transform fires with { sessionID }
 * 4. We look up the context and inject the appropriate prompt
 * 5. Todo enforcer / background tasks use model context when sending prompts
 */

export interface SessionModel {
  providerID: string
  modelID: string
}

export interface SessionContext {
  agent?: string
  model?: SessionModel
}

/** Map of sessionID to session context */
const sessionContextMap = new Map<string, SessionContext>()

/**
 * Record context (agent + model) for a session.
 * Called from chat.message hook.
 */
export function setSessionContext(
  sessionID: string,
  context: { agent?: string; model?: SessionModel }
): void {
  const existing = sessionContextMap.get(sessionID) ?? {}
  sessionContextMap.set(sessionID, {
    agent: context.agent ?? existing.agent,
    model: context.model ?? existing.model,
  })
}

/**
 * Get the full context for a session.
 */
export function getSessionContext(sessionID: string): SessionContext | undefined {
  return sessionContextMap.get(sessionID)
}

/**
 * Record which agent is active for a session (legacy helper).
 * Called from chat.message hook.
 */
export function setSessionAgent(sessionID: string, agent: string | undefined): void {
  if (agent) {
    setSessionContext(sessionID, { agent })
  }
}

/**
 * Get the active agent for a session.
 * Called from experimental.chat.system.transform hook.
 */
export function getSessionAgent(sessionID: string): string | undefined {
  return sessionContextMap.get(sessionID)?.agent
}

/**
 * Get the active model for a session.
 */
export function getSessionModel(sessionID: string): SessionModel | undefined {
  return sessionContextMap.get(sessionID)?.model
}

/**
 * Clear tracking for a session (on deletion).
 */
export function clearSessionAgent(sessionID: string | undefined): void {
  if (sessionID) {
    sessionContextMap.delete(sessionID)
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
