import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { BackgroundManager } from "../src/background"
import {
  explorerAgent,
  librarianAgent,
  oracleAgent,
  uiPlannerAgent,
  inspectorAgent,
} from "../src/agents"
import { READ_ONLY_TOOLS } from "../src/agents/tool-policy"
import { ZenoxConfigSchema } from "../src/config"
import { ORCHESTRATION_PROMPT } from "../src/orchestration/prompt"
import { createKeywordDetectorHook } from "../src/hooks"

function createMockClient(opts: { neverResolvePrompt?: boolean } = {}): OpencodeClient {
  let counter = 0
  const aborted: string[] = []
  const client = {
    session: {
      create: async () => ({ data: { id: `child_${++counter}` } }),
      prompt: async () => {
        if (opts.neverResolvePrompt) {
          return new Promise(() => {}) // never resolves -> task stays "running"
        }
        return { data: {} }
      },
      abort: async ({ path }: { path: { id: string } }) => {
        aborted.push(path.id)
        return { data: {} }
      },
      messages: async () => ({ data: [] }),
    },
  } as unknown as OpencodeClient
  ;(client as unknown as { __aborted: string[] }).__aborted = aborted
  return client
}

function abortedIds(client: OpencodeClient): string[] {
  return (client as unknown as { __aborted: string[] }).__aborted
}

function launch(manager: BackgroundManager, client: OpencodeClient, parentSessionID: string, description = "t") {
  return manager.launch(client, { agent: "explorer", description, prompt: "p", parentSessionID })
}

describe("tool-policy hardening", () => {
  test("READ_ONLY_TOOLS denies the write-family and bash/task explicitly (not by omission)", () => {
    expect(READ_ONLY_TOOLS.write).toBe(false)
    expect(READ_ONLY_TOOLS.edit).toBe(false)
    expect(READ_ONLY_TOOLS.patch).toBe(false)
    expect(READ_ONLY_TOOLS.bash).toBe(false)
    expect(READ_ONLY_TOOLS.task).toBe(false)
  })

  test("explorer, librarian, oracle spread the shared read-only policy", () => {
    for (const agent of [explorerAgent, librarianAgent, oracleAgent]) {
      expect(agent.tools?.write).toBe(false)
      expect(agent.tools?.edit).toBe(false)
      expect(agent.tools?.patch).toBe(false)
      expect(agent.tools?.bash).toBe(false)
      expect(agent.tools?.task).toBe(false)
    }
  })

  test("ui-planner does not spread the read-only policy (it writes and runs bash)", () => {
    expect(uiPlannerAgent.tools?.write).toBe(true)
    expect(uiPlannerAgent.tools?.edit).toBe(true)
    // patch is deliberately absent, not explicitly false, so it doesn't
    // collapse the write/edit permission key back to denied.
    expect(uiPlannerAgent.tools?.patch).toBeUndefined()
  })

  test("inspector re-enables bash after spreading the read-only policy (its whole job is running checks)", () => {
    expect(inspectorAgent.tools?.write).toBe(false)
    expect(inspectorAgent.tools?.edit).toBe(false)
    expect(inspectorAgent.tools?.patch).toBe(false)
    expect(inspectorAgent.tools?.task).toBe(false)
    expect(inspectorAgent.tools?.bash).toBe(true)
  })
})

describe("inspector agent", () => {
  test("has a structured verdict contract and escalation rule", () => {
    expect(inspectorAgent.prompt).toContain("PASS | PARTIAL | FAIL | BLOCKED")
    expect(inspectorAgent.prompt).toContain("stable failure signature")
    expect(inspectorAgent.prompt).toContain("escalate to oracle")
    expect(inspectorAgent.prompt).toContain("Never edit, write, or fix")
  })

  test("is registered with model and read+bash-only tools", () => {
    expect(inspectorAgent.mode).toBe("subagent")
    expect(inspectorAgent.model).toBe("anthropic/claude-sonnet-5")
    expect(inspectorAgent.tools?.read).toBe(true)
    expect(inspectorAgent.tools?.glob).toBe(true)
    expect(inspectorAgent.tools?.grep).toBe(true)
  })
})

describe("orchestration prompt: inspector + verification protocol", () => {
  test("documents inspector delegation and the verification protocol", () => {
    expect(ORCHESTRATION_PROMPT).toContain("**Inspector**")
    expect(ORCHESTRATION_PROMPT).toContain('"inspector"')
    expect(ORCHESTRATION_PROMPT).toContain("### Verification Protocol")
    expect(ORCHESTRATION_PROMPT).toContain("Done when:")
    expect(ORCHESTRATION_PROMPT).toContain("not making progress")
  })

  test("documents background_list and the task timeout", () => {
    expect(ORCHESTRATION_PROMPT).toContain("background_list")
    expect(ORCHESTRATION_PROMPT).toContain("aborted automatically")
  })

  test("documents the blueprint keyword", () => {
    expect(ORCHESTRATION_PROMPT).toContain("`blueprint`")
  })
})

describe("config schema: inspector + background timeout", () => {
  test("accepts inspector in disabled_agents and agents overrides", () => {
    const parsed = ZenoxConfigSchema.safeParse({
      disabled_agents: ["inspector"],
      agents: { inspector: { model: "anthropic/claude-opus-4-8" } },
    })
    expect(parsed.success).toBe(true)
  })

  test("accepts background.timeout_minutes", () => {
    const parsed = ZenoxConfigSchema.safeParse({ background: { timeout_minutes: 15 } })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.background?.timeout_minutes).toBe(15)
    }
  })

  test("rejects out-of-range timeout_minutes", () => {
    const parsed = ZenoxConfigSchema.safeParse({ background: { timeout_minutes: 0 } })
    expect(parsed.success).toBe(false)
  })
})

describe("background task timeout", () => {
  test("a task that never goes idle is aborted and marked failed after the timeout", async () => {
    const manager = new BackgroundManager()
    manager.setLimits({ maxConcurrent: 5, maxPerSession: 50, taskTimeoutMs: 20 })
    const client = createMockClient({ neverResolvePrompt: true })

    const task = await launch(manager, client, "timeout-session")
    expect(task.status).toBe("running")

    // Wait past the 20ms timeout.
    await new Promise((r) => setTimeout(r, 60))

    const current = manager.getTask(task.id)
    expect(current?.status).toBe("failed")
    expect(current?.error).toContain("Timed out")
    expect(abortedIds(client)).toContain(task.sessionID)
    // The slot must be freed for new launches.
    expect(manager.listActiveTasks().length).toBe(0)
  })

  test("a task that completes before the timeout is never aborted", async () => {
    const manager = new BackgroundManager()
    manager.setLimits({ maxConcurrent: 5, maxPerSession: 50, taskTimeoutMs: 5_000 })
    const client = createMockClient()

    const task = await launch(manager, client, "fast-session")
    manager.handleSessionIdle(task.sessionID)

    await new Promise((r) => setTimeout(r, 20))
    expect(abortedIds(client)).not.toContain(task.sessionID)
    expect(manager.getTask(task.id)?.status).toBe("completed")
  })

  test("dispose() clears pending timeout timers", async () => {
    const manager = new BackgroundManager()
    manager.setLimits({ maxConcurrent: 5, maxPerSession: 50, taskTimeoutMs: 10_000 })
    const client = createMockClient()
    await launch(manager, client, "dispose-session")

    manager.dispose()
    // If the timer weren't cleared, this would eventually fire and throw
    // inside a torn-down manager. Waiting briefly is enough to prove it doesn't.
    await new Promise((r) => setTimeout(r, 20))
    expect(manager.listAllTasks().length).toBe(0)
  })
})

describe("notification double-fire fix", () => {
  test("calling getCompletionStatusForSession again after all-complete does not resend", async () => {
    const manager = new BackgroundManager()
    const client = createMockClient()

    const a = await launch(manager, client, "notif-session", "task a")

    // handleSessionIdle itself returns (and consumes) the all-complete notification.
    const first = manager.handleSessionIdle(a.sessionID)
    expect(first?.allComplete).toBe(true)
    expect(first?.completedTasks.map((t) => t.id)).toEqual([a.id])

    // Calling it again manually must find nothing new to report (a is now notified).
    const second = manager.getCompletionStatusForSession("notif-session")
    expect(second).toBeNull()
  })

  test("a still-unnotified task remains reportable across a partial notification, then gets folded into the final all-complete list exactly once", async () => {
    const manager = new BackgroundManager()
    const client = createMockClient()

    const a = await launch(manager, client, "notif-session-2", "task a")
    const b = await launch(manager, client, "notif-session-2", "task b")

    // a finishes first; b still running -> partial, a is not yet marked notified.
    const partial = manager.handleSessionIdle(a.sessionID)
    expect(partial?.allComplete).toBe(false)

    // b finishes -> both a and b are now unnotified-and-finished -> one final list.
    const final = manager.handleSessionIdle(b.sessionID)
    expect(final?.allComplete).toBe(true)
    expect(final?.completedTasks.map((t) => t.id).sort()).toEqual([a.id, b.id].sort())

    // A further manual call must find nothing left to report.
    expect(manager.getCompletionStatusForSession("notif-session-2")).toBeNull()
  })
})

describe("cancel() race fix", () => {
  test("status flips to cancelled before abort resolves, so a late session.idle is not misread as completion", async () => {
    const manager = new BackgroundManager()
    let resolveAbort: () => void = () => {}
    const client = {
      session: {
        create: async () => ({ data: { id: "child_cancel" } }),
        prompt: async () => new Promise(() => {}),
        abort: async () => {
          await new Promise<void>((r) => { resolveAbort = r })
          return { data: {} }
        },
      },
    } as unknown as OpencodeClient

    const task = await launch(manager, client, "cancel-session")
    const cancelPromise = manager.cancel(client, task.id)

    // While abort() is still in flight, the task must already read "cancelled".
    expect(manager.getTask(task.id)?.status).toBe("cancelled")

    // Simulate the child's session.idle arriving before abort() resolves.
    const notification = manager.handleSessionIdle(task.sessionID)
    expect(notification).toBeNull() // status is no longer "running", so it's ignored
    expect(manager.getTask(task.id)?.status).toBe("cancelled") // not overwritten to "completed"

    resolveAbort()
    expect(await cancelPromise).toBe(true)
  })

  test("cancel() returns true even if the underlying abort() rejects", async () => {
    const manager = new BackgroundManager()
    const client = {
      session: {
        create: async () => ({ data: { id: "child_reject" } }),
        prompt: async () => new Promise(() => {}),
        abort: async () => {
          throw new Error("already gone")
        },
      },
    } as unknown as OpencodeClient

    const task = await launch(manager, client, "cancel-session-2")
    expect(await manager.cancel(client, task.id)).toBe(true)
    expect(manager.getTask(task.id)?.status).toBe("cancelled")
  })
})

describe("background_cancel tool surfaces all-complete when it was the last task", () => {
  test("cancelling the only running task returns the ALL COMPLETE message", async () => {
    const { createBackgroundTools } = await import("../src/background/tools")
    const manager = new BackgroundManager()
    const client = createMockClient({ neverResolvePrompt: true })
    const tools = createBackgroundTools(manager, client)

    const task = await launch(manager, client, "cancel-tool-session")
    const result = await tools.background_cancel.execute(
      { task_id: task.id },
      { sessionID: "cancel-tool-session" } as never
    )

    expect(result).toContain("has been cancelled")
    expect(result).toContain("ALL BACKGROUND TASKS COMPLETE")
  })

  test("cancelling one of several running tasks does not falsely claim all-complete", async () => {
    const { createBackgroundTools } = await import("../src/background/tools")
    const manager = new BackgroundManager()
    const client = createMockClient({ neverResolvePrompt: true })
    const tools = createBackgroundTools(manager, client)

    const taskA = await launch(manager, client, "cancel-tool-session-2", "a")
    await launch(manager, client, "cancel-tool-session-2", "b")

    const result = await tools.background_cancel.execute(
      { task_id: taskA.id },
      { sessionID: "cancel-tool-session-2" } as never
    )

    expect(result).toContain("has been cancelled")
    expect(result).not.toContain("ALL BACKGROUND TASKS COMPLETE")
  })
})

describe("detachParentSession aborts running children", () => {
  test("with a client, still-running tasks for a deleted session are aborted and dropped", async () => {
    const manager = new BackgroundManager()
    const client = createMockClient({ neverResolvePrompt: true })

    const task = await launch(manager, client, "detach-session")
    manager.detachParentSession("detach-session", client)

    expect(abortedIds(client)).toContain(task.sessionID)
    expect(manager.listAllTasks().some((t) => t.id === task.id)).toBe(false)
  })

  test("without a client, running tasks are left alone (silenced, not aborted) — back-compat", async () => {
    const manager = new BackgroundManager()
    const client = createMockClient({ neverResolvePrompt: true })

    const task = await launch(manager, client, "detach-session-2")
    manager.detachParentSession("detach-session-2")

    expect(abortedIds(client)).not.toContain(task.sessionID)
    expect(manager.listAllTasks().some((t) => t.id === task.id)).toBe(true)
  })
})

describe("hasActiveBackgroundWork (todo-enforcer integration)", () => {
  test("true while a task is running, false once finished and past the grace window", async () => {
    const manager = new BackgroundManager()
    const client = createMockClient()

    const task = await launch(manager, client, "enforcer-session")
    expect(manager.hasActiveBackgroundWork("enforcer-session")).toBe(true)

    manager.handleSessionIdle(task.sessionID)
    // Still within the default 60s grace window.
    expect(manager.hasActiveBackgroundWork("enforcer-session")).toBe(true)
    // Outside a much shorter custom grace window.
    expect(manager.hasActiveBackgroundWork("enforcer-session", 0)).toBe(false)
  })

  test("false for a session with no background tasks", () => {
    const manager = new BackgroundManager()
    expect(manager.hasActiveBackgroundWork("no-tasks-session")).toBe(false)
  })
})

describe("schema.json stays in sync with the Zod config schema", () => {
  const schemaJson = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "schema.json"), "utf-8")
  ) as {
    properties: {
      agents: { properties: Record<string, unknown> }
      disabled_agents: { items: { enum: string[] } }
      background: { properties: Record<string, unknown> }
    }
  }

  test("lists inspector as a configurable agent and a disable-able one", () => {
    expect(schemaJson.properties.agents.properties.inspector).toBeDefined()
    expect(schemaJson.properties.disabled_agents.items.enum).toContain("inspector")
  })

  test("all five builtin agent names are present in both places", () => {
    const agentNames = ["explorer", "librarian", "oracle", "ui-planner", "inspector"]
    for (const name of agentNames) {
      expect(schemaJson.properties.agents.properties[name]).toBeDefined()
      expect(schemaJson.properties.disabled_agents.items.enum).toContain(name)
    }
  })

  test("documents background.timeout_minutes", () => {
    expect(schemaJson.properties.background.properties.timeout_minutes).toBeDefined()
  })
})

describe("blueprint keyword", () => {
  test("injects blueprint-mode context and shows the toast", async () => {
    const toasts: Array<{ title: string; message: string }> = []
    const hook = createKeywordDetectorHook({
      client: {
        tui: {
          showToast: async ({ body }: { body: { title: string; message: string } }) => {
            toasts.push({ title: body.title, message: body.message })
            return true
          },
        },
      },
    } as never)

    const output = {
      parts: [{ type: "text", text: "let's blueprint this feature before writing code" }],
      message: {},
    }

    await hook["chat.message"]?.({ sessionID: "blueprint-session" }, output)

    expect(output.parts[0]?.text).toContain("BLUEPRINT MODE")
    expect(output.parts[0]?.text).toContain('Done when:')
    expect(toasts.at(-1)?.title).toBe("📐 Blueprint Mode")
  })
})
