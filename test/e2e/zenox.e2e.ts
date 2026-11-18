/**
 * End-to-end: Zenox inside the real OpenCode engine (in-memory database, fake
 * Anthropic API, no network). Run with `bun run test:e2e`.
 */
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { blocked, calledTools, hasText, lastUserText, start, type Harness, type ModelCall, type Reply } from "./harness"

const TIMEOUT = 60_000
let h: Harness | undefined

afterEach(async () => {
  try {
    // Only OpenCode's own loopback model-runtime discovery probes may be refused.
    expect(blocked.filter((url) => !/^http:\/\/127\.0\.0\.1:(1234|11434|8000)\//.test(url))).toEqual([])
  } finally {
    blocked.length = 0
    await h?.close()
    h = undefined
  }
})

/** Zenox tools live in Code Mode: the model calls them through `execute`. */
const code = (js: string): Reply => ({ tool: "execute", input: { code: js } })
const user = (call: ModelCall) => lastUserText(call)
const settle = () => new Promise((r) => setTimeout(r, 400))
/** The task ID listed in the completion notice (the prompt also contains example IDs). */
const taskId = (call: ModelCall) => call.raw.match(/- (bg_[0-9a-f]{8}): /)?.[1]

type Message = Record<string, unknown> & { type: string }
const synthetic = (messages: Message[], kind: string) =>
  messages.filter((m) => m.type === "synthetic" && (m.metadata as { kind?: string } | undefined)?.kind === kind)

describe("Zenox loads into OpenCode 2.3", () => {
  test("registers the five agents on their default models and the orchestration prompt", async () => {
    h = await start()
    type AgentList = { data: Array<{ id: string; mode: string; model?: { providerID: string; id: string } }> }
    // Since OpenCode 2.2.7, agent.list returns the agents loaded so far while plugins still load.
    const agents = await h.until(async () => {
      const list = (await h!.sdk.agent.list({ location: h!.location } as never)) as unknown as AgentList
      return list.data.some((a) => a.id === "inspector") && list
    }, "Zenox agents registered")
    const byId = new Map(agents.data.map((a) => [a.id, a]))
    expect(byId.get("explorer")?.model).toEqual({ providerID: "anthropic", id: "claude-haiku-5-5" })
    expect(byId.get("librarian")?.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5" })
    expect(byId.get("ui-planner")?.model).toEqual({ providerID: "anthropic", id: "claude-opus-5-5" })
    expect(byId.get("inspector")?.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5" })
    // The harness points oracle at Anthropic through zenox.json (default is OpenAI).
    expect(byId.get("oracle")?.model).toEqual({ providerID: "anthropic", id: "claude-opus-5-5" })
    for (const id of ["explorer", "librarian", "oracle", "ui-planner", "inspector"]) {
      expect(byId.get(id)?.mode).toBe("subagent")
    }

    const s = await h.session()
    await h.prompt(s, "hello")
    await h.wait(s)
    const chat = h.chats()[0]!
    expect(chat.system).toContain("## Sub-Agent Delegation")
    expect(chat.system).toContain("### Choosing a Model (Only When the User Asks)")
    // Zenox tools are reachable (Code Mode catalog) and subagent is a direct tool.
    for (const tool of ["background_task", "background_output", "session_search", "session_read", "save_project_guideline"]) {
      expect(chat.raw).toContain(tool)
    }
    expect(chat.tools).toContain("subagent")
  }, TIMEOUT)
})

describe("background_task", () => {
  test("default: the child runs on the agent's default model and the result comes back once", async () => {
    h = await start()
    h.script = (call) => {
      if (hasText(call, "LAUNCH_DEFAULT") && calledTools(call).length === 0)
        return code(`return await tools.background_task({ agent: "explorer", description: "find auth", prompt: "CHILD_DEFAULT" })`)
      if (user(call).includes("CHILD_DEFAULT")) return { text: "child result: auth lives in src/auth.ts" }
      if (user(call).includes("ALL BACKGROUND TASKS COMPLETE") && !calledTools(call).includes("execute"))
        return { text: "unexpected" }
      if (hasText(call, "ALL BACKGROUND TASKS COMPLETE") && !hasText(call, "BG_OUTPUT_DONE") && calledTools(call).length === 1)
        return code(`const out = await tools.background_output({ task_id: "${taskId(call)}" }); return "BG_OUTPUT_DONE " + out`)
      if (hasText(call, "BG_OUTPUT_DONE")) return { text: "FINAL" }
      return { text: "waiting" }
    }
    const s = await h.session()
    await h.prompt(s, "LAUNCH_DEFAULT")
    await h.until(() => h!.chats().some((c) => hasText(c, "BG_OUTPUT_DONE")), "background_output result")
    await h.wait(s)
    await settle()

    const child = h.chats().filter((c) => user(c).includes("CHILD_DEFAULT"))
    expect(child.map((c) => c.model)).toEqual(["claude-haiku-5-5"])
    expect(child[0]!.system).toContain("codebase search specialist")

    const launched = h.chats().find((c) => user(c).includes("Background task launched successfully"))!
    expect(user(launched)).toContain("- Model: agent default")

    const retrieved = h.chats().find((c) => hasText(c, "BG_OUTPUT_DONE"))!
    expect(user(retrieved)).toContain("child result: auth lives in src/auth.ts")

    // The Zenox notice is a synthetic system notice, never a fake user message.
    const messages = (await h.context(s)) as Message[]
    const notices = synthetic(messages, "background")
    expect(notices).toHaveLength(1)
    expect(notices[0]!.description).toBe("Zenox: background tasks complete")
    expect(messages.filter((m) => m.type === "user" && String(m.text).includes("BACKGROUND TASK"))).toHaveLength(0)

    // Zenox's notice and OpenCode's own <subagent> report wake the parent once, not twice.
    const wakes = h.chats().filter(
      (c) => c.model === "claude-sonnet-5-5" && hasText(c, "ALL BACKGROUND TASKS COMPLETE") && !hasText(c, "BG_OUTPUT_DONE")
    )
    expect(wakes).toHaveLength(1)

    const children = (await h.sdk.session.list({ location: h.location, parentID: s } as never)) as unknown as {
      data: Array<{ agent?: string; model?: { id: string } }>
    }
    expect(children.data).toHaveLength(1)
    expect(children.data[0]!.agent).toBe("explorer")
  }, TIMEOUT)

  test("override: the user-requested model runs that one task", async () => {
    h = await start()
    h.script = (call) => {
      if (hasText(call, "LAUNCH_OVERRIDE") && calledTools(call).length === 0)
        return code(
          `return await tools.background_task({ agent: "explorer", description: "deep look", prompt: "CHILD_OVERRIDE", model: "anthropic/claude-opus-5-5" })`
        )
      if (user(call).includes("CHILD_OVERRIDE")) return { text: "override result" }
      if (hasText(call, "LAUNCH_SECOND") && !hasText(call, "CHILD_SECOND_LAUNCHED") && user(call).includes("LAUNCH_SECOND"))
        return code(
          `await tools.background_task({ agent: "explorer", description: "plain", prompt: "CHILD_SECOND" }); return "CHILD_SECOND_LAUNCHED"`
        )
      if (user(call).includes("CHILD_SECOND")) return { text: "second result" }
      return { text: "ok" }
    }
    const s = await h.session()
    await h.prompt(s, "LAUNCH_OVERRIDE")
    await h.until(() => h!.chats().some((c) => hasText(c, "Zenox: background tasks complete") || hasText(c, "ALL BACKGROUND TASKS COMPLETE")), "notice")
    await h.wait(s)

    const child = h.chats().filter((c) => user(c).includes("CHILD_OVERRIDE"))
    expect(child.map((c) => c.model)).toEqual(["claude-opus-5-5"])
    const launched = h.chats().find((c) => user(c).includes("Background task launched successfully"))!
    expect(user(launched)).toContain("- Model: anthropic/claude-opus-5-5")
    const notice = h.chats().find((c) => hasText(c, "ALL BACKGROUND TASKS COMPLETE"))!
    expect(notice.raw).toContain("deep look (explorer on anthropic/claude-opus-5-5)")

    // The next task goes back to the agent's default model.
    await h.prompt(s, "LAUNCH_SECOND")
    await h.until(() => h!.chats().some((c) => user(c).includes("CHILD_SECOND") && !user(c).includes("LAUNCHED")), "second child")
    const second = h.chats().filter((c) => user(c).includes("CHILD_SECOND") && !user(c).includes("LAUNCHED"))
    expect(second.map((c) => c.model)).toEqual(["claude-haiku-5-5"])
    await h.wait(s)
  }, TIMEOUT)

  test("variants are checked against the real model catalog", async () => {
    h = await start()
    const catalog = (await h.sdk.model.list({ location: h.location } as never)) as unknown as {
      data: Array<{ id: string; providerID: string; variants: Array<{ id: string }> }>
    }
    const withVariant = catalog.data.find((m) => m.providerID === "anthropic" && m.variants.length > 0)!
    expect(withVariant).toBeDefined()
    const variant = withVariant.variants[0]!.id
    h.script = (call) => {
      if (hasText(call, "LAUNCH_VARIANT") && calledTools(call).length === 0)
        return code(
          `return await tools.background_task({ agent: "explorer", description: "v", prompt: "CHILD_VARIANT", model: "anthropic/${withVariant.id}#${variant}" })`
        )
      if (user(call).includes("CHILD_VARIANT")) return { text: "variant result" }
      return { text: "ok" }
    }
    const s = await h.session()
    await h.prompt(s, "LAUNCH_VARIANT")
    await h.until(() => h!.chats().some((c) => user(c).includes("CHILD_VARIANT")), "variant child")
    expect(h.chats().find((c) => user(c).includes("CHILD_VARIANT"))!.model).toBe(withVariant.id)
    const children = (await h.sdk.session.list({ location: h.location, parentID: s } as never)) as unknown as {
      data: Array<{ model?: { id: string; variant?: string } }>
    }
    expect(children.data[0]!.model).toMatchObject({ id: withVariant.id, variant })
    await h.wait(s)
  }, TIMEOUT)

  test("an unknown model or variant is refused before any session is created", async () => {
    h = await start()
    h.script = (call) => {
      if (hasText(call, "LAUNCH_BAD") && calledTools(call).length === 0)
        return code(`
          const a = await tools.background_task({ agent: "explorer", description: "x", prompt: "CHILD_BAD", model: "anthropic/claude-does-not-exist" })
          const b = await tools.background_task({ agent: "explorer", description: "y", prompt: "CHILD_BAD", model: "anthropic/claude-haiku-5-5#no-such-variant" })
          const c = await tools.background_task({ agent: "explorer", description: "z", prompt: "CHILD_BAD", model: "not-a-model" })
          return [a, b, c].join("\\n---\\n")`)
      return { text: "ok" }
    }
    const s = await h.session()
    await h.prompt(s, "LAUNCH_BAD")
    await h.wait(s)
    await settle()
    const result = user(h.chats().find((c) => user(c).includes("Failed to launch"))!)
    expect(result).toContain('Model \\"anthropic/claude-does-not-exist\\" is not available')
    expect(result).toMatch(/Variant \\"no-such-variant\\" is not available|has no variants/)
    expect(result).toContain('Invalid model \\"not-a-model\\"')
    expect(h.chats().some((c) => user(c).includes("CHILD_BAD"))).toBe(false)
    const children = (await h.sdk.session.list({ location: h.location, parentID: s } as never)) as unknown as { data: unknown[] }
    expect(children.data).toHaveLength(0)
  }, TIMEOUT)
})

describe("OpenCode's subagent tool with Zenox agents", () => {
  test("uses the agent's default model, and a model only when one is passed", async () => {
    h = await start()
    h.script = (call) => {
      if (hasText(call, "RUN_ORACLE") && calledTools(call).length === 0)
        return {
          tools: [
            { tool: "subagent", input: { agent: "oracle", description: "default", prompt: "ORACLE_DEFAULT" } },
            {
              tool: "subagent",
              input: { agent: "oracle", description: "override", prompt: "ORACLE_OVERRIDE", model: "anthropic/claude-haiku-5-5" },
            },
          ],
        }
      if (user(call).includes("ORACLE_DEFAULT")) return { text: "oracle default says hi" }
      if (user(call).includes("ORACLE_OVERRIDE")) return { text: "oracle override says hi" }
      return { text: "ok" }
    }
    const s = await h.session()
    await h.prompt(s, "RUN_ORACLE")
    await h.until(
      () => h!.chats().some((c) => hasText(c, "oracle default says hi")) && h!.chats().some((c) => hasText(c, "oracle override says hi")),
      "both oracle reports"
    )
    await h.wait(s)
    const def = h.chats().filter((c) => user(c).includes("ORACLE_DEFAULT"))
    const over = h.chats().filter((c) => user(c).includes("ORACLE_OVERRIDE"))
    expect(def.map((c) => c.model)).toEqual(["claude-opus-5-5"])
    expect(over.map((c) => c.model)).toEqual(["claude-haiku-5-5"])
    expect(def[0]!.system).toContain(over[0]!.system.slice(0, 200))
  }, TIMEOUT)
})

describe("todo continuation", () => {
  const todoConfig = { opencode: { experimental: { todo: true } } }
  const todos = (...items: Array<[string, string]>) => ({
    tool: "todowrite",
    input: { todos: items.map(([content, status]) => ({ content, status })) },
  })

  test("keeps going while todos are unfinished, then stops when they are done", async () => {
    h = await start(todoConfig)
    h.script = (call) => {
      const last = user(call)
      if (last.includes("TODO_RUN")) return todos(["step one", "in_progress"], ["step two", "pending"])
      if (last.includes("[TODO CONTINUATION]")) return todos(["step one", "completed"], ["step two", "completed"])
      if (calledTools(call).filter((t) => t === "todowrite").length === 2) return { text: "All done." }
      return { text: "Working on step one." }
    }
    const s = await h.session()
    await h.prompt(s, "TODO_RUN")
    await h.until(() => h!.chats().some((c) => calledTools(c).filter((t) => t === "todowrite").length === 2), "finished todos")
    await h.wait(s)
    await settle()

    expect(h.chats()[0]!.tools).toContain("todowrite")
    const messages = (await h.context(s)) as Message[]
    const reminders = synthetic(messages, "todo-continuation")
    expect(reminders).toHaveLength(1)
    expect(String(reminders[0]!.text)).toContain("- [in_progress] step one")
    expect(String(reminders[0]!.text)).toContain("- [pending] step two")
    expect(reminders[0]!.description).toBe("Zenox: continuing unfinished todos")
    const finalText = JSON.stringify(messages.filter((m) => m.type === "assistant").at(-1))
    expect(finalText).toContain("All done.")
    const count = h.chats().length
    await settle()
    expect(h.chats().length).toBe(count)
  }, TIMEOUT)

  test("stops after the list stops changing (no infinite loop)", async () => {
    h = await start(todoConfig)
    h.script = (call) => (user(call).includes("TODO_STALL") ? todos(["stuck", "pending"]) : { text: "Still thinking." })
    const s = await h.session()
    await h.prompt(s, "TODO_STALL")
    await h.wait(s)
    await settle()
    await h.wait(s)
    const reminders = synthetic((await h.context(s)) as Message[], "todo-continuation")
    expect(reminders).toHaveLength(2)
    const count = h.chats().length
    await settle()
    expect(h.chats().length).toBe(count)
  }, TIMEOUT)

  test("never overrides a question to the user, and respects enabled: false", async () => {
    h = await start(todoConfig)
    h.script = (call) => (user(call).includes("TODO_ASK") ? todos(["pick a db", "pending"]) : { text: "Postgres or SQLite?" })
    const s = await h.session()
    await h.prompt(s, "TODO_ASK")
    await h.wait(s)
    await settle()
    expect(synthetic((await h.context(s)) as Message[], "todo-continuation")).toHaveLength(0)
    await h.close()

    h = await start({ ...todoConfig, zenox: { todo_continuation: { enabled: false } } })
    h.script = (call) => (user(call).includes("TODO_OFF") ? todos(["x", "pending"]) : { text: "Working." })
    const s2 = await h.session()
    await h.prompt(s2, "TODO_OFF")
    await h.wait(s2)
    await settle()
    expect(synthetic((await h.context(s2)) as Message[], "todo-continuation")).toHaveLength(0)
  }, TIMEOUT)
})

describe("session_search / session_read", () => {
  test("finds a past session in this project and reads it", async () => {
    h = await start()
    h.script = () => ({ text: "noted" })
    const old = await h.session({ title: "Payment refactor notes" })
    await h.prompt(old, "remember PAYMENT_SECRET_MARKER")
    await h.wait(old)

    h.script = (call) => {
      if (hasText(call, "FIND_IT") && calledTools(call).length === 0)
        return code(`return await tools.session_search({ query: "Payment" })`)
      if (hasText(call, "FIND_IT") && calledTools(call).length === 1)
        return code(`return "READ_DONE " + (await tools.session_read({ session_id: "${old}" }))`)
      return { text: "done" }
    }
    const s = await h.session()
    await h.prompt(s, "FIND_IT")
    await h.wait(s)
    const search = user(h.chats().find((c) => user(c).includes("Sessions matching"))!)
    expect(search).toContain(old)
    expect(search).toContain("Payment refactor notes")
    expect(search).not.toContain(s)
    const read = user(h.chats().find((c) => user(c).includes("READ_DONE"))!)
    expect(read).toContain("PAYMENT_SECRET_MARKER")
    expect(read).toContain("noted")
  }, TIMEOUT)

  test("never reads a session that belongs to another project", async () => {
    h = await start()
    const otherDir = join(h.root, "other-project")
    await mkdir(otherDir)
    h.script = () => ({ text: "noted" })
    const foreign = await h.sdk.session.create({
      location: { directory: otherDir },
      model: { providerID: "anthropic", id: "claude-sonnet-5-5" },
    } as never)
    await h.prompt(foreign.id, "OTHER_PROJECT_SECRET")
    await h.wait(foreign.id)

    h.script = (call) => {
      if (hasText(call, "PEEK") && calledTools(call).length === 0)
        return code(`
          const search = await tools.session_search({ query: "OTHER_PROJECT_SECRET" })
          const read = await tools.session_read({ session_id: "${foreign.id}" })
          return "PEEK_DONE " + search + "\\n---\\n" + read`)
      return { text: "done" }
    }
    const s = await h.session()
    await h.prompt(s, "PEEK")
    await h.wait(s)
    const result = user(h.chats().find((c) => user(c).includes("PEEK_DONE"))!)
    expect(result).toContain(`Session ${foreign.id} is not part of this project.`)
    expect(result).not.toContain(`- ${foreign.id}`)
    expect(result.split("PEEK_DONE")[1]).not.toContain("OTHER_PROJECT_SECRET\\n")
  }, TIMEOUT)
})
