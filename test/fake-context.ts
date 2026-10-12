/**
 * In-memory stand-in for the slice of the OpenCode V2 plugin context Zenox uses.
 * Mirrors the documented semantics: transforms replay onto fresh state, hooks are
 * stored by name, events are pushed through an async iterable.
 */

import type { ZenoxContext } from "../src/plugin"
import type { ZenoxToast } from "../src/shared/toast"

export interface FakeAgent {
  description?: string
  mode?: string
  system?: string
  color?: string
  hidden?: boolean
  model?: { providerID: string; id: string; variant?: string }
  permissions: Array<{ action: string; resource: string; effect: string }>
}

export interface FakeTool {
  name: string
  description: string
  input: unknown
  execute: (input: unknown, context: { sessionID: string; agent: string }) => Promise<{ content?: unknown }>
}

export interface FakeSkill {
  id: string
  name: string
  description?: string
  path: string
  content: string
}

type Hook = (event: never) => unknown

export interface FakeEvent {
  type: string
  data: Record<string, unknown>
}

export interface FakeContextOptions {
  existingSkills?: string[]
  existingAgents?: Record<string, FakeAgent>
  sessions?: Record<string, { parentID?: string; agent?: string }>
  /** prompt() throws for the first `times` calls whose text matches `match`. */
  failPrompt?: { match: string; times: number }
  /** session.wait resolves immediately and context reports an assistant reply. */
  autoComplete?: boolean
  /** Event stream delivers nothing (anomalyco/opencode#44788). */
  silentEvents?: boolean
}

export function createFakeContext(options: FakeContextOptions = {}) {
  const agents = new Map<string, FakeAgent>()
  const mcps = new Map<string, unknown>()
  const skills = new Map<string, FakeSkill>()
  const tools = new Map<string, FakeTool>()
  const sessionHooks = new Map<string, Hook>()
  const toolHooks = new Map<string, Hook>()
  const toasts: ZenoxToast[] = []
  const created: Array<Record<string, unknown>> = []
  const prompts: Array<{ sessionID: string; text: string; resume?: boolean }> = []
  const interrupted: string[] = []
  const sessions = new Map(Object.entries(options.sessions ?? {}))
  let childCounter = 0
  let failingAttempts = 0
  const waiters = new Map<string, Array<() => void>>()
  const finished = new Set<string>()

  const queue: FakeEvent[] = []
  let wake: (() => void) | undefined
  let subscriptions = 0
  let aborted = false

  const ctx = {
    location: { directory: "/tmp/zenox-fake-project" },
    rpc: {
      register: async () => ({
        dispose: async () => {},
        events: {
          emit: async (_name: string, data: ZenoxToast) => {
            toasts.push(data)
          },
        },
      }),
    },
    agent: {
      transform: async (callback: (editor: unknown) => void) => {
        agents.clear()
        for (const [id, agent] of Object.entries(options.existingAgents ?? {})) {
          agents.set(id, structuredClone(agent))
        }
        callback({
          list: () => [...agents.values()],
          get: (id: string) => agents.get(id),
          default: () => {},
          remove: (id: string) => agents.delete(id),
          update: (id: string, update: (agent: FakeAgent) => void) => {
            const agent = agents.get(id) ?? { permissions: [] }
            update(agent)
            agents.set(id, agent)
          },
        })
        return { dispose: async () => {} }
      },
    },
    mcp: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          set: (name: string, config: unknown) => mcps.set(name, config),
          get: (name: string) => mcps.get(name),
          list: () => [...mcps.entries()],
          update: () => {},
          remove: (name: string) => mcps.delete(name),
        })
        return { dispose: async () => {} }
      },
    },
    skill: {
      transform: async (callback: (editor: unknown) => void) => {
        skills.clear()
        for (const id of options.existingSkills ?? []) {
          skills.set(id, { id, name: id, path: `/user/skills/${id}/SKILL.md`, content: "user" })
        }
        callback({
          list: () => [...skills.values()],
          get: (id: string) => skills.get(id),
          add: (skill: FakeSkill) => skills.set(skill.id, skill),
          update: () => {},
          remove: (id: string) => skills.delete(id),
        })
        return { dispose: async () => {} }
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: FakeTool) => tools.set(tool.name, tool),
          list: () => [...tools.values()],
          get: (id: string) => tools.get(id),
          namespace: () => {},
          update: () => {},
          remove: (id: string) => tools.delete(id),
        })
        return { dispose: async () => {} }
      },
      hook: async (name: string, callback: Hook) => {
        toolHooks.set(name, callback)
        return { dispose: async () => {} }
      },
    },
    session: {
      hook: async (name: string, callback: Hook) => {
        sessionHooks.set(name, callback)
        return { dispose: async () => {} }
      },
      create: async (input: Record<string, unknown>) => {
        created.push(input)
        const id = `child_${++childCounter}`
        sessions.set(id, { parentID: input.parentID as string, agent: input.agent as string })
        return { id }
      },
      prompt: async (input: { sessionID: string; text: string; resume?: boolean }) => {
        if (options.failPrompt && input.text.includes(options.failPrompt.match)) {
          if (++failingAttempts <= options.failPrompt.times) throw new Error("simulated failure")
        }
        prompts.push(input)
        return {}
      },
      wait: async (input: { sessionID: string }) => {
        if (options.autoComplete || finished.has(input.sessionID)) return
        await new Promise<void>((resolve) => {
          waiters.set(input.sessionID, [...(waiters.get(input.sessionID) ?? []), resolve])
        })
      },
      interrupt: async (input: { sessionID: string }) => {
        interrupted.push(input.sessionID)
        return { interrupted: true }
      },
      context: async (input: { sessionID: string }) =>
        options.autoComplete || finished.has(input.sessionID)
          ? [{ type: "assistant", content: [{ type: "text", text: `done ${input.sessionID}` }] }]
          : [],
      get: async (input: { sessionID: string }) => {
        const session = sessions.get(input.sessionID)
        if (!session) throw new Error("not found")
        return { id: input.sessionID, ...session }
      },
    },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal } = {}) => {
        subscriptions++
        signal?.addEventListener("abort", () => {
          aborted = true
          wake?.()
        })
        return {
          async *[Symbol.asyncIterator]() {
            while (!signal?.aborted) {
              const next = queue.shift()
              if (next) {
                yield next
                continue
              }
              await new Promise<void>((resolve) => (wake = resolve))
            }
          },
        }
      },
    },
  }

  const flush = () => new Promise((r) => setTimeout(r, 5))

  return {
    ctx: ctx as unknown as ZenoxContext,
    agents,
    mcps,
    skills,
    tools,
    sessionHooks,
    toolHooks,
    toasts,
    created,
    prompts,
    /** Prompts sent to sessions other than background children (notifications). */
    get notices() {
      return prompts.filter((p) => !p.sessionID.startsWith("child_"))
    },
    interrupted,
    sessions,
    get subscriptions() {
      return subscriptions
    },
    get aborted() {
      return aborted
    },
    /** Finish a child session's agent loop (resolves session.wait). */
    async finish(sessionID: string) {
      finished.add(sessionID)
      for (const resolve of waiters.get(sessionID) ?? []) resolve()
      waiters.delete(sessionID)
      await flush()
    },
    /** Push an event and let handlers run. */
    async emit(event: FakeEvent) {
      if (options.silentEvents) return flush()
      queue.push(event)
      wake?.()
      await flush()
    },
    runSessionHook<E>(name: string, event: E) {
      return (sessionHooks.get(name) as ((event: E) => unknown) | undefined)?.(event)
    },
    runToolHook<E>(name: string, event: E) {
      return (toolHooks.get(name) as ((event: E) => unknown) | undefined)?.(event)
    },
    async callTool(name: string, input: unknown, context: { sessionID: string; agent?: string }) {
      const tool = tools.get(name)
      if (!tool) throw new Error(`tool ${name} not registered`)
      const result = await tool.execute(input, { agent: "build", ...context })
      return String(result.content)
    },
    flush,
  }
}
