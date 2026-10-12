import type { BackgroundSessionHost, SessionMessageText } from "../src/background"

export interface FakeHostOptions {
  /** prompt() never resolves (task stays "running" until idled). */
  neverResolvePrompt?: boolean
  /** prompt() rejects with this message. */
  failPrompt?: string
  /** createChildSession() waits this long before resolving. */
  createDelayMs?: number
  /** createChildSession() rejects when an agent is passed. */
  rejectAgent?: boolean
  /** waitForCompletion() never resolves on its own (completion driven by handleSessionIdle). */
  manualCompletion?: boolean
  /** interrupt() behavior. */
  interrupt?: (sessionID: string) => Promise<void>
  messages?: (sessionID: string) => Promise<SessionMessageText[]>
}

export interface FakeHost extends BackgroundSessionHost {
  readonly interrupted: string[]
  readonly created: Array<{ parentSessionID: string; agent?: string; title: string; id: string }>
  readonly prompts: Array<{ sessionID: string; text: string }>
}

export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  let counter = 0
  const interrupted: string[] = []
  const created: FakeHost["created"] = []
  const prompts: FakeHost["prompts"] = []
  return {
    interrupted,
    created,
    prompts,
    async createChildSession(input) {
      if (options.createDelayMs) await new Promise((r) => setTimeout(r, options.createDelayMs))
      if (options.rejectAgent && input.agent) throw new Error(`Agent not found: ${input.agent}`)
      const id = `child_${++counter}`
      created.push({ ...input, id })
      return id
    },
    async prompt(sessionID, text) {
      prompts.push({ sessionID, text })
      if (options.failPrompt) throw new Error(options.failPrompt)
      if (options.neverResolvePrompt) return new Promise<void>(() => {})
    },
    async waitForCompletion() {
      if (options.manualCompletion !== false) return new Promise<void>(() => {})
    },
    async interrupt(sessionID) {
      interrupted.push(sessionID)
      if (options.interrupt) await options.interrupt(sessionID)
    },
    async readMessages(sessionID) {
      return options.messages ? options.messages(sessionID) : []
    },
  }
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
