import { describe, expect, test } from "bun:test"
import { setupZenox } from "../src/plugin"
import type { ZenoxConfig } from "../src/config"
import { ZenoxConfigSchema } from "../src/config"
import { createModelValidator, parseModelRef } from "../src/host/v2"
import {
  DEFAULT_MAX_CONTINUATIONS,
  MAX_STALLS,
  TODO_CONTINUATION_MARKER,
  TodoContinuationTracker,
  readTodos,
  type TranscriptMessage,
} from "../src/features/todo-continuation"
import { readSession, searchSessions, type SessionApi } from "../src/tools/session-search"
import { AGENTS, DEFAULT_MODELS } from "../src/cli/constants"
import { BUILTIN_AGENTS } from "../src/agents/resolve"
import { createFakeContext, type FakeContextOptions } from "./fake-context"

const CATALOG = [
  { id: "claude-haiku-5-5", providerID: "anthropic", type: "chat", variants: [] },
  { id: "claude-opus-5-5", providerID: "anthropic", type: "chat", variants: [{ id: "high" }, { id: "max" }] },
  { id: "gpt-6.1-sol", providerID: "openai", type: "chat", variants: [{ id: "medium" }, { id: "high" }] },
  { id: "gpt-image-2", providerID: "openai", type: "image", variants: [] },
  { id: "anthropic/claude-x", providerID: "openrouter", type: "chat", variants: [] },
]

async function start(config: ZenoxConfig = {}, options: FakeContextOptions = {}) {
  const fake = createFakeContext({ models: CATALOG, ...options })
  const cleanup = await setupZenox(fake.ctx, { config })
  await fake.flush()
  return Object.assign(fake, { cleanup })
}

const launch = (
  z: Awaited<ReturnType<typeof start>>,
  input: Record<string, unknown>,
  sessionID = "parent"
) => z.callTool("background_task", { agent: "explorer", description: "d", prompt: "p", ...input }, { sessionID })

// ---------------------------------------------------------------------------
describe("background_task model override", () => {
  test("no model: the agent's default model is used and the catalog is not consulted", async () => {
    const z = await start()
    const out = await launch(z, {})
    expect(out).toContain("launched successfully")
    expect(out).toContain("- Model: agent default")
    expect(z.created[0]).not.toHaveProperty("model")
    expect(z.modelListCalls).toHaveLength(0)
    await z.cleanup()
  })

  test("blank model is treated as not set", async () => {
    const z = await start()
    const out = await launch(z, { model: "   " })
    expect(out).toContain("- Model: agent default")
    expect(z.created[0]).not.toHaveProperty("model")
    await z.cleanup()
  })

  test("a valid model creates the child session on that model", async () => {
    const z = await start()
    const out = await launch(z, { model: "anthropic/claude-opus-5-5" })
    expect(out).toContain("- Model: anthropic/claude-opus-5-5")
    expect(z.created[0]?.model).toEqual({ providerID: "anthropic", id: "claude-opus-5-5" })
    expect(z.modelListCalls[0]).toEqual({
      location: { directory: "/tmp/zenox-fake-project" },
      types: ["chat", "decision", "image"],
    })
    await z.cleanup()
  })

  test("a valid variant is passed through", async () => {
    const z = await start()
    await launch(z, { model: " openai/gpt-6.1-sol#high " })
    expect(z.created[0]?.model).toEqual({ providerID: "openai", id: "gpt-6.1-sol", variant: "high" })
    await z.cleanup()
  })

  test("model IDs containing slashes resolve against the right provider", async () => {
    const z = await start()
    await launch(z, { model: "openrouter/anthropic/claude-x" })
    expect(z.created[0]?.model).toEqual({ providerID: "openrouter", id: "anthropic/claude-x" })
    await z.cleanup()
  })

  const rejected: Array<[string, string]> = [
    ["gpt-6", 'Invalid model "gpt-6"'],
    ["anthropic/", 'Invalid model "anthropic/"'],
    ["anthropic/claude-nope", 'Model "anthropic/claude-nope" is not available'],
    ["openai/gpt-image-2", "is a image model; background tasks need a chat model"],
    ["anthropic/claude-opus-5-5#ultra", 'Variant "ultra" is not available for "anthropic/claude-opus-5-5". Available: high, max.'],
    ["anthropic/claude-haiku-5-5#high", 'Model "anthropic/claude-haiku-5-5" has no variants. Omit the variant.'],
  ]
  for (const [model, message] of rejected) {
    test(`rejects ${model} without creating a session`, async () => {
      const z = await start()
      const out = await launch(z, { model })
      expect(out).toStartWith("Failed to launch background task:")
      expect(out).toContain(message)
      expect(z.created).toHaveLength(0)
      expect(z.toasts).toHaveLength(0)
      await z.cleanup()
    })
  }

  test("an unavailable catalog does not block the task (session.create decides)", async () => {
    const z = await start({}, { modelListFails: true })
    const out = await launch(z, { model: "anthropic/anything" })
    expect(out).toContain("launched successfully")
    expect(z.created[0]?.model).toEqual({ providerID: "anthropic", id: "anything" })
    await z.cleanup()
  })

  test("the override is shown in the toast, background_list and the completion notice", async () => {
    const z = await start()
    await launch(z, { model: "anthropic/claude-opus-5-5#high" }, "p")
    expect(z.toasts[0]?.message).toContain("Agent: explorer (anthropic/claude-opus-5-5#high)")
    const list = await z.callTool("background_list", {}, { sessionID: "p" })
    expect(list).toContain("(explorer on anthropic/claude-opus-5-5#high,")
    await z.finish("child_1")
    expect(z.notices[0]?.text).toContain("(explorer on anthropic/claude-opus-5-5#high)")
    await z.cleanup()
  })

  test("default-model tasks keep the plain agent label", async () => {
    const z = await start()
    await launch(z, {}, "p")
    expect(await z.callTool("background_list", {}, { sessionID: "p" })).toContain("(explorer,")
    await z.finish("child_1")
    expect(z.notices[0]?.text).toContain(": d (explorer)")
    await z.cleanup()
  })

  test("the override applies to one task only", async () => {
    const z = await start()
    await launch(z, { model: "anthropic/claude-opus-5-5" })
    await launch(z, {})
    expect(z.created[0]?.model).toBeDefined()
    expect(z.created[1]).not.toHaveProperty("model")
    await z.cleanup()
  })

  test("the model parameter tells the agent to leave it unset unless the user asks", async () => {
    const z = await start()
    const input = z.tools.get("background_task")!.input as { properties: { model: { description: string } } }
    expect(input.properties.model.description).toStartWith("NEVER set this unless the user explicitly asks")
    await z.cleanup()
  })
})

describe("parseModelRef / createModelValidator", () => {
  test("parseModelRef trims and keeps slashes in the model ID", () => {
    expect(parseModelRef("  a/b/c#v ") as unknown).toEqual({ providerID: "a", id: "b/c", variant: "v" })
    expect(parseModelRef("a/b#") as unknown).toEqual({ providerID: "a", id: "b" })
    expect(parseModelRef("/b")).toBeUndefined()
    expect(parseModelRef("ab")).toBeUndefined()
  })

  test("validator normalises the accepted value", async () => {
    const validate = createModelValidator(async () => ({ data: CATALOG }))
    expect(await validate(" anthropic/claude-opus-5-5#max ")).toEqual({ ok: true, model: "anthropic/claude-opus-5-5#max" })
  })

  test("models without a type are treated as chat models", async () => {
    const validate = createModelValidator(async () => ({ data: [{ id: "m", providerID: "p" }] }))
    expect(await validate("p/m")).toEqual({ ok: true, model: "p/m" })
  })
})

// ---------------------------------------------------------------------------
const todoCall = (todos: unknown, status = "completed"): TranscriptMessage => ({
  type: "assistant",
  content: [{ type: "tool", name: "todowrite", state: { status, input: { todos } } }],
})
const said = (text: string): TranscriptMessage => ({ type: "assistant", content: [{ type: "text", text }] })
const open2 = [
  { content: "one", status: "in_progress" },
  { content: "two", status: "pending" },
]

describe("todo continuation: readTodos", () => {
  test("uses the latest completed todowrite call only", () => {
    const todos = readTodos([
      todoCall([{ content: "old", status: "pending" }]),
      todoCall([{ content: "new", status: "completed" }]),
      todoCall([{ content: "failed call", status: "pending" }], "error"),
    ])
    expect(todos).toEqual([{ content: "new", status: "completed" }])
  })

  test("drops malformed entries and defaults unknown statuses to pending", () => {
    expect(
      readTodos([todoCall([{ content: "" }, null, 3, { status: "pending" }, { content: "ok", status: "weird" }])])
    ).toEqual([{ content: "ok", status: "pending" }])
    expect(readTodos([todoCall("not an array")])).toEqual([])
    expect(readTodos([{ type: "user", text: "hi" }])).toEqual([])
  })

  test("ignores other tools", () => {
    expect(
      readTodos([{ type: "assistant", content: [{ type: "tool", name: "read", state: { status: "completed", input: { todos: open2 } } }] }])
    ).toEqual([])
  })
})

/** Decide and, like the plugin after a successful delivery, commit. */
const go = (t: TodoContinuationTracker, sessionID: string, messages: TranscriptMessage[]) => {
  const decision = t.decide(sessionID, messages)
  decision.commit?.()
  return decision
}

describe("todo continuation: TodoContinuationTracker", () => {
  test("an uncommitted decision changes nothing", () => {
    const t = new TodoContinuationTracker(1)
    expect(t.decide("s", [todoCall(open2)]).continue).toBe(true)
    expect(t.decide("s", [todoCall(open2)]).continue).toBe(true)
    expect(go(t, "s", [todoCall(open2)]).continue).toBe(true)
    expect(go(t, "s", [todoCall(open2)])).toMatchObject({ continue: false, reason: "limit" })
  })

  test("no todos / all done → leave the session alone", () => {
    const t = new TodoContinuationTracker()
    expect(go(t, "s", [said("hi")])).toMatchObject({ continue: false, reason: "no-todos" })
    expect(
      go(t, "s", [todoCall([{ content: "a", status: "completed" }, { content: "b", status: "cancelled" }])])
    ).toMatchObject({ continue: false, reason: "done" })
  })

  test("unfinished todos → continue with a reminder that lists only open todos", () => {
    const t = new TodoContinuationTracker()
    const d = go(t, "s", [todoCall([...open2, { content: "three", status: "completed" }]), said("Working.")])
    expect(d.continue).toBe(true)
    expect(d.open).toBe(2)
    expect(d.reminder).toContain(TODO_CONTINUATION_MARKER)
    expect(d.reminder).toContain("- [in_progress] one")
    expect(d.reminder).toContain("- [pending] two")
    expect(d.reminder).not.toContain("three")
    expect(d.reminder).toContain(`continuation 1/${DEFAULT_MAX_CONTINUATIONS}`)
  })

  test("a question to the user is never overridden", () => {
    const t = new TodoContinuationTracker()
    expect(go(t, "s", [todoCall(open2), said("Should I use Postgres or SQLite?")])).toMatchObject({
      continue: false,
      reason: "asking-user",
    })
  })

  test(`stops after ${MAX_STALLS} continuations with an unchanged list`, () => {
    const t = new TodoContinuationTracker()
    const transcript = [todoCall(open2), said("Working.")]
    expect(go(t, "s", transcript).continue).toBe(true)
    expect(go(t, "s", transcript).continue).toBe(true)
    expect(go(t, "s", transcript)).toMatchObject({ continue: false, reason: "stalled" })
    expect(go(t, "s", transcript).continue).toBe(false)
  })

  test("progress resets the stall counter", () => {
    const t = new TodoContinuationTracker()
    expect(go(t, "s", [todoCall(open2)]).continue).toBe(true)
    expect(go(t, "s", [todoCall(open2)]).continue).toBe(true)
    const progressed = [{ content: "one", status: "completed" }, { content: "two", status: "in_progress" }]
    expect(go(t, "s", [todoCall(progressed)]).continue).toBe(true)
    expect(go(t, "s", [todoCall(progressed)]).continue).toBe(true)
  })

  test("respects the continuation limit; a user prompt (reset) restores the budget", () => {
    const t = new TodoContinuationTracker(2)
    let n = 0
    const step = () => go(t, "s", [todoCall([{ content: `t${n++}`, status: "pending" }])])
    expect(step().continue).toBe(true)
    expect(step().continue).toBe(true)
    expect(step()).toMatchObject({ continue: false, reason: "limit" })
    t.reset("s")
    expect(step().continue).toBe(true)
  })

  test("sessions are tracked independently", () => {
    const t = new TodoContinuationTracker(1)
    expect(go(t, "a", [todoCall(open2)]).continue).toBe(true)
    expect(go(t, "a", [todoCall(open2)]).continue).toBe(false)
    expect(go(t, "b", [todoCall(open2)]).continue).toBe(true)
  })
})

describe("todo continuation: idle hook wiring", () => {
  const idle = (z: Awaited<ReturnType<typeof start>>, sessionID: string, background: unknown[] = []) =>
    z.runSessionHook("experimental.idle", { sessionID, background }) as Promise<void>
  const base = { sessions: { p: {} }, transcripts: { p: [todoCall(open2), said("Working.")] } }

  test("injects a synthetic reminder and a toast when todos are unfinished", async () => {
    const z = await start({}, base)
    await idle(z, "p")
    expect(z.continuations).toHaveLength(1)
    expect(z.continuations[0]).toMatchObject({
      sessionID: "p",
      description: "Zenox: continuing unfinished todos",
      metadata: { source: "zenox", kind: "todo-continuation" },
    })
    expect(z.continuations[0]?.text).toContain(TODO_CONTINUATION_MARKER)
    expect(z.toasts.at(-1)?.title).toBe("📋 Continuing todos")
    await z.cleanup()
  })

  test("disabled in config → nothing happens", async () => {
    const z = await start({ todo_continuation: { enabled: false } }, base)
    await idle(z, "p")
    expect(z.continuations).toHaveLength(0)
    await z.cleanup()
  })

  test("max_continuations from config is honoured, with a pause toast", async () => {
    const z = await start({ todo_continuation: { max_continuations: 1 } }, base)
    await idle(z, "p")
    z.transcripts.set("p", [todoCall([{ content: "changed", status: "pending" }])])
    await idle(z, "p")
    expect(z.continuations).toHaveLength(1)
    expect(z.toasts.at(-1)?.title).toBe("📋 Todo continuation paused")
    await z.cleanup()
  })

  test("a real user prompt resets the budget; Zenox notices do not", async () => {
    const z = await start({ todo_continuation: { max_continuations: 1 } }, base)
    await idle(z, "p")
    z.runSessionHook("prompt", { sessionID: "p", prompt: { text: "<system-reminder>x</system-reminder>" } })
    await idle(z, "p")
    expect(z.continuations).toHaveLength(1)
    z.runSessionHook("prompt", { sessionID: "p", prompt: { text: "keep going please" } })
    await idle(z, "p")
    expect(z.continuations).toHaveLength(2)
    await z.cleanup()
  })

  test("subagent child sessions are never continued", async () => {
    const z = await start({}, { sessions: { c: { parentID: "p" } }, transcripts: { c: [todoCall(open2)] } })
    await idle(z, "c")
    expect(z.continuations).toHaveLength(0)
    await z.cleanup()
  })

  test("waits while the session's own subagent/image/codemode work runs, but not for shells", async () => {
    const z = await start({}, base)
    await idle(z, "p", [{ kind: "subagent", sessionID: "p", childSessionID: "x", agent: "explorer", description: "d" }])
    await idle(z, "p", [{ kind: "codemode", sessionID: "p", jobID: "j" }])
    expect(z.continuations).toHaveLength(0)
    // A descendant's work does not wake this session, so it does not block.
    await idle(z, "p", [{ kind: "subagent", sessionID: "other", childSessionID: "x", agent: "a", description: "d" }])
    expect(z.continuations).toHaveLength(1)
    await idle(z, "p", [{ kind: "shell", sessionID: "p", shellID: "s", command: "bun dev" }])
    expect(z.continuations).toHaveLength(2)
    await z.cleanup()
  })

  test("waits while Zenox background tasks of this session run", async () => {
    const z = await start({}, base)
    await launch(z, {}, "p")
    await idle(z, "p")
    expect(z.continuations).toHaveLength(0)
    await z.cleanup()
  })

  test("a failed reminder delivery does not use up the continuation budget", async () => {
    const z = await start(
      { todo_continuation: { max_continuations: 1 } },
      { ...base, failSynthetic: { match: TODO_CONTINUATION_MARKER, times: 1 } }
    )
    await idle(z, "p")
    expect(z.continuations).toHaveLength(0)
    await idle(z, "p")
    expect(z.continuations).toHaveLength(1)
    await z.cleanup()
  })

  test("errors inside continuation never escape the hook", async () => {
    const z = await start({}, { transcripts: { ghost: [todoCall(open2)] } })
    await expect(idle(z, "ghost")).resolves.toBeUndefined()
    expect(z.continuations).toHaveLength(0)
    await z.cleanup()
  })

  test("the session.deleted event forgets the session's budget", async () => {
    const z = await start({ todo_continuation: { max_continuations: 1 } }, base)
    await idle(z, "p")
    await z.emit({ type: "session.deleted", data: { sessionID: "p" } })
    await idle(z, "p")
    expect(z.continuations).toHaveLength(2)
    await z.cleanup()
  })
})

// ---------------------------------------------------------------------------
describe("background completion via the idle hook", () => {
  test("a child's idle hook notifies the parent without waiting for session.wait", async () => {
    const z = await start()
    await launch(z, {}, "p")
    // child_1 never resolves session.wait in this fake unless finish() is called.
    await z.runSessionHook("experimental.idle", { sessionID: "child_1", background: [] })
    await z.flush()
    expect(z.notices).toHaveLength(1)
    expect(z.notices[0]).toMatchObject({
      sessionID: "p",
      resume: true,
      description: "Zenox: background tasks complete",
    })
    // The later session.wait / session.idle paths are idempotent.
    await z.finish("child_1")
    await z.emit({ type: "session.idle", data: { sessionID: "child_1" } })
    expect(z.notices).toHaveLength(1)
    await z.cleanup()
  })

  test("notices are synthetic (never a fake user prompt) and partial ones do not resume", async () => {
    const z = await start()
    await launch(z, {}, "p")
    await launch(z, {}, "p")
    await z.finish("child_1")
    expect(z.notices[0]).toMatchObject({ resume: false, description: "Zenox: background task finished" })
    expect(z.prompts.filter((p) => p.sessionID === "p")).toHaveLength(0)
    await z.cleanup()
  })

  test("Zenox still loads on an OpenCode without the experimental.idle hook", async () => {
    const z = await start({}, { noIdleHook: true })
    expect(z.sessionHooks.has("experimental.idle")).toBe(false)
    await launch(z, {}, "p")
    await z.finish("child_1")
    expect(z.notices).toHaveLength(1)
    await z.cleanup()
  })

  test("the event stream only subscribes to the events Zenox handles", async () => {
    const z = await start()
    expect(z.subscribeOptions[0]?.types).toEqual(["session.idle", "session.deleted"])
    await z.cleanup()
  })
})

// ---------------------------------------------------------------------------
describe("session_search / session_read", () => {
  const sessionList = [
    { id: "ses_a", title: "Payment refactor", agent: "build", model: { providerID: "anthropic", id: "m" }, time: { created: 0, updated: Date.UTC(2026, 10, 1, 9, 30) } },
    { id: "ses_cur", title: "This one", time: { created: 0, updated: 0 } },
    { id: "ses_c", parentID: "ses_a", time: { created: 0, updated: 0 } },
  ]

  test("search is scoped to the project, newest first, and skips the current session", async () => {
    const z = await start({}, { sessionList })
    const out = await z.callTool("session_search", { query: " payment ", limit: 5 }, { sessionID: "ses_cur" })
    expect(z.listCalls[0]).toEqual({ directory: "/tmp/zenox-fake-project", order: "desc", limit: 5, search: "payment" })
    expect(out).toContain('Sessions matching "payment":')
    expect(out).toContain("- ses_a — Payment refactor (updated 2026-11-01 09:30, build, anthropic/m)")
    expect(out).toContain("- ses_c — (untitled)")
    expect(out).toContain("subagent")
    expect(out).not.toContain("ses_cur")
    await z.cleanup()
  })

  test("no query lists recent sessions with a default limit", async () => {
    const z = await start({}, { sessionList })
    const out = await z.callTool("session_search", {}, { sessionID: "x" })
    expect(z.listCalls[0]).toEqual({ directory: "/tmp/zenox-fake-project", order: "desc", limit: 10 })
    expect(out).toStartWith("Recent sessions:")
    await z.cleanup()
  })

  const here = async () => ({ location: { directory: "/d" } })

  test("empty results say so", async () => {
    const api: SessionApi = { list: async () => ({ data: [] }), context: async () => [], get: here }
    expect(await searchSessions(api, "/d", { query: "zzz" })).toBe('No sessions found matching "zzz".')
    expect(await searchSessions(api, "/d", {})).toBe("No other sessions found in this project.")
  })

  test("invalid limits are rejected by the schema", async () => {
    const z = await start()
    expect(await z.callTool("session_search", { limit: 0 }, { sessionID: "x" })).toContain("Invalid input for session_search")
    await z.cleanup()
  })

  test("read renders user and assistant text, tool names, and truncates long messages", async () => {
    const api: SessionApi = {
      list: async () => ({ data: [] }),
      context: async () => [
        { type: "user", text: "fix the bug" },
        { type: "assistant", content: [{ type: "text", text: "Looking" }, { type: "tool", name: "read" }] },
        { type: "idle" },
        { type: "assistant", content: [{ type: "text", text: "x".repeat(2_500) }] },
      ],
      get: here,
    }
    const out = await readSession(api, "/d", { session_id: "s" })
    expect(out).toContain("### user\nfix the bug")
    expect(out).toContain("### assistant\nLooking\n[tool: read]")
    expect(out).toContain("… [truncated]")
    expect(out).not.toContain("idle")
  })

  test("read honours the limit and reports omitted messages", async () => {
    const api: SessionApi = {
      list: async () => ({ data: [] }),
      context: async () => [1, 2, 3].map((n) => ({ type: "user", text: `m${n}` })),
      get: here,
    }
    const out = await readSession(api, "/d/", { session_id: "s", limit: 1 })
    expect(out).toStartWith("(2 earlier message(s) omitted)")
    expect(out).toContain("m3")
    expect(out).not.toContain("m1")
  })

  test("read reports missing sessions and empty transcripts", async () => {
    const failing: SessionApi = {
      list: async () => ({ data: [] }),
      context: async () => [],
      get: async () => { throw new Error("not found") },
    }
    expect(await readSession(failing, "/d", { session_id: "nope" })).toBe("Could not read session nope: not found")
    const empty: SessionApi = { list: async () => ({ data: [] }), context: async () => [], get: here }
    expect(await readSession(empty, "/d", { session_id: "e" })).toBe("Session e has no messages.")
  })

  test("read refuses sessions from other projects (and unknown locations) without reading them", async () => {
    let read = 0
    const api = (location?: { directory: string }): SessionApi => ({
      list: async () => ({ data: [] }),
      context: async () => { read++; return [{ type: "user", text: "secret" }] },
      get: async () => (location ? { location } : {}),
    })
    expect(await readSession(api({ directory: "/other" }), "/d", { session_id: "x" })).toBe("Session x is not part of this project.")
    expect(await readSession(api({ directory: "/d/sub" }), "/d", { session_id: "x" })).toBe("Session x is not part of this project.")
    expect(await readSession(api(), "/d", { session_id: "x" })).toBe("Session x is not part of this project.")
    expect(read).toBe(0)
  })
})

// ---------------------------------------------------------------------------
describe("config and CLI", () => {
  test("todo_continuation config is validated", () => {
    expect(ZenoxConfigSchema.safeParse({ todo_continuation: { enabled: false, max_continuations: 5 } }).success).toBe(true)
    expect(ZenoxConfigSchema.safeParse({ todo_continuation: { max_continuations: 0 } }).success).toBe(false)
    expect(ZenoxConfigSchema.safeParse({ todo_continuation: { max_continuations: 51 } }).success).toBe(false)
  })

  test("the CLI's default models always match the agents' real defaults", () => {
    for (const agent of AGENTS) {
      const builtin = BUILTIN_AGENTS[agent.name].model.split("#")[0]
      expect(agent.defaultModel).toBe(builtin)
      expect(DEFAULT_MODELS[agent.name]).toBe(builtin)
    }
  })
})
