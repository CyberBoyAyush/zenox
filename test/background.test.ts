import { describe, expect, test } from "bun:test"
import {
  BackgroundManager,
  BackgroundLimitError,
  DEFAULT_BACKGROUND_LIMITS,
  cancelBackgroundTask,
  launchBackgroundTask,
  listBackgroundTasks,
} from "../src/background"
import { createFakeHost, tick } from "./helpers"

function setup(options: Parameters<typeof createFakeHost>[0] = {}) {
  const host = createFakeHost(options)
  const manager = new BackgroundManager(host)
  return { host, manager }
}

function launch(manager: BackgroundManager, parentSessionID: string, description = "t") {
  return manager.launch({ agent: "explorer", description, prompt: "p", parentSessionID })
}

function childOf(manager: BackgroundManager, description: string): string {
  const task = manager.listAllTasks().find((t) => t.description === description)
  if (!task) throw new Error(`no task with description ${description}`)
  return task.sessionID
}

describe("launch", () => {
  test("creates a child session of the parent with the agent and sends the prompt", async () => {
    const { host, manager } = setup()
    const task = await manager.launch({
      agent: "librarian",
      description: "find docs",
      prompt: "look it up",
      parentSessionID: "parent",
    })
    await tick()
    expect(host.created[0]).toMatchObject({ parentSessionID: "parent", agent: "librarian" })
    expect(host.created[0]?.title).toContain("find docs")
    expect(host.prompts).toEqual([{ sessionID: task.sessionID, text: "look it up" }])
    expect(task.status).toBe("running")
    expect(task.id).toMatch(/^bg_/)
  })

  test("fails closed when the agent is rejected (never runs as the default agent)", async () => {
    const { host, manager } = setup({ rejectAgent: true })
    await expect(launch(manager, "parent")).rejects.toThrow("Agent not found")
    expect(host.created).toHaveLength(0)
    expect(manager.listActiveTasks()).toHaveLength(0)
    expect(manager.checkLaunchAllowed("parent")).toBeNull()
  })

  test("waiting on the child completes the task without any session.idle event", async () => {
    const { manager } = setup({ manualCompletion: false })
    const idled: string[] = []
    manager.setChildIdleListener((sessionID) => {
      idled.push(sessionID)
      manager.handleSessionIdle(sessionID)
    })
    const task = await launch(manager, "parent")
    await tick(5)
    expect(idled).toEqual([task.sessionID])
    expect(manager.getTask(task.id)?.status).toBe("completed")
  })

  test("background_task is refused inside a background child session", async () => {
    const { manager } = setup()
    const task = await launch(manager, "parent")
    const out = await launchBackgroundTask(
      manager,
      { agent: "explorer", description: "nested", prompt: "p" },
      task.sessionID
    )
    expect(out).toContain("not available inside a background task")
    expect(manager.listAllTasks()).toHaveLength(1)
  })

  test("a failing prompt marks the task failed and notifies the parent", async () => {
    const { manager } = setup({ failPrompt: "boom: backend rejected" })
    const notified: string[] = []
    manager.setCompletionNotifier((n) => notified.push(n.parentSessionID))
    const task = await launch(manager, "parent_x", "doomed")
    await tick(10)
    expect(manager.getTask(task.id)?.status).toBe("failed")
    expect(manager.getTask(task.id)?.error).toContain("boom")
    expect(notified).toContain("parent_x")
  })
})

describe("concurrency limits", () => {
  test("defaults are 6 concurrent / 50 per session / 30 min", () => {
    expect(DEFAULT_BACKGROUND_LIMITS).toEqual({
      maxConcurrent: 6,
      maxPerSession: 50,
      taskTimeoutMs: 30 * 60_000,
    })
  })

  test("checkLaunchAllowed and launch() both reject beyond max_concurrent", async () => {
    const { manager } = setup()
    manager.setLimits({ maxConcurrent: 2, maxPerSession: 100 })
    await launch(manager, "s")
    await launch(manager, "s")
    expect(manager.checkLaunchAllowed("s")).toContain("Concurrency limit")
    await expect(launch(manager, "s")).rejects.toBeInstanceOf(BackgroundLimitError)
    expect(manager.listActiveTasks().length).toBe(2)
  })

  test("circuit breaker rejects beyond max_per_session even when nothing runs", async () => {
    const { manager } = setup()
    manager.setLimits({ maxConcurrent: 100, maxPerSession: 2 })
    const a = await launch(manager, "s")
    const b = await launch(manager, "s")
    manager.handleSessionIdle(a.sessionID)
    manager.handleSessionIdle(b.sessionID)
    expect(manager.checkLaunchAllowed("s")).toContain("circuit breaker")
    await expect(launch(manager, "s")).rejects.toBeInstanceOf(BackgroundLimitError)
  })

  test("per-session spawn count is isolated between sessions", async () => {
    const { manager } = setup()
    manager.setLimits({ maxConcurrent: 100, maxPerSession: 1 })
    await launch(manager, "session-a")
    expect(manager.checkLaunchAllowed("session-a")).not.toBeNull()
    expect(manager.checkLaunchAllowed("session-b")).toBeNull()
  })

  test("setLimits ignores undefined and keeps existing values", () => {
    const { manager } = setup()
    manager.setLimits({ maxConcurrent: 10 })
    expect(manager.getLimits().maxConcurrent).toBe(10)
    expect(manager.getLimits().maxPerSession).toBe(DEFAULT_BACKGROUND_LIMITS.maxPerSession)
    manager.setLimits(undefined)
    expect(manager.getLimits().maxConcurrent).toBe(10)
  })

  test("concurrent launches cannot overshoot max_concurrent (TOCTOU)", async () => {
    const { manager } = setup({ createDelayMs: 10 })
    manager.setLimits({ maxConcurrent: 3, maxPerSession: 100 })
    await Promise.all(Array.from({ length: 10 }, () => launch(manager, "burst").catch(() => null)))
    expect(manager.listActiveTasks().length).toBeLessThanOrEqual(3)
  })

  test("long-running tasks hold their slot until idle", async () => {
    const { manager } = setup()
    manager.setLimits({ maxConcurrent: 2, maxPerSession: 100 })
    const t1 = await launch(manager, "long")
    await launch(manager, "long")
    await expect(launch(manager, "long")).rejects.toBeInstanceOf(BackgroundLimitError)
    manager.handleSessionIdle(t1.sessionID)
    expect((await launch(manager, "long")).status).toBe("running")
  })

  test("dispose clears all state and timers", async () => {
    const { manager } = setup()
    manager.setLimits({ taskTimeoutMs: 10_000 })
    await launch(manager, "main")
    manager.dispose()
    await tick(10)
    expect(manager.listAllTasks().length).toBe(0)
  })
})

describe("timeouts", () => {
  test("a task that never goes idle is interrupted and failed after the timeout", async () => {
    const { host, manager } = setup({ neverResolvePrompt: true })
    manager.setLimits({ taskTimeoutMs: 20 })
    const task = await launch(manager, "timeout")
    await tick(60)
    expect(manager.getTask(task.id)?.status).toBe("failed")
    expect(manager.getTask(task.id)?.error).toContain("Timed out")
    expect(host.interrupted).toContain(task.sessionID)
    expect(manager.listActiveTasks().length).toBe(0)
  })

  test("a task that completes in time is never interrupted", async () => {
    const { host, manager } = setup()
    manager.setLimits({ taskTimeoutMs: 5_000 })
    const task = await launch(manager, "fast")
    manager.handleSessionIdle(task.sessionID)
    await tick(10)
    expect(host.interrupted).not.toContain(task.sessionID)
    expect(manager.getTask(task.id)?.status).toBe("completed")
  })
})

describe("notification scoping", () => {
  test("notifications only include tasks of the originating parent", async () => {
    const { manager } = setup()
    const a = await launch(manager, "parent_a", "task a")
    const b = await launch(manager, "parent_b", "task b")
    const n = manager.handleSessionIdle(a.sessionID)
    expect(n?.parentSessionID).toBe("parent_a")
    expect(n?.allComplete).toBe(true)
    expect(n?.completedTasks.map((t) => t.id)).toEqual([a.id])
    expect(n?.message).not.toContain(b.id)
  })

  test("running count is per parent", async () => {
    const { manager } = setup()
    const a1 = await launch(manager, "parent_a", "a1")
    const a2 = await launch(manager, "parent_a", "a2")
    await launch(manager, "parent_b", "b1")
    const first = manager.handleSessionIdle(a1.sessionID)
    expect(first?.allComplete).toBe(false)
    expect(first?.runningCount).toBe(1)
    expect(first?.message).toContain("[BACKGROUND TASK COMPLETE]")
    const second = manager.handleSessionIdle(a2.sessionID)
    expect(second?.allComplete).toBe(true)
    expect(second?.completedTasks.map((t) => t.id).sort()).toEqual([a1.id, a2.id].sort())
    expect(second?.message).toContain("[ALL BACKGROUND TASKS COMPLETE]")
  })

  test("partial notification names the task that just finished", async () => {
    const { manager } = setup()
    const a = await launch(manager, "p", "task a")
    await launch(manager, "p", "task b")
    await launch(manager, "p", "task c")
    expect(manager.handleSessionIdle(childOf(manager, "task c"))?.message).toContain("task c")
    const n2 = manager.handleSessionIdle(a.sessionID)
    expect(n2?.message).toContain("task a")
    expect(n2?.message).not.toContain("task c")
  })

  test("detached parent: completions silenced and dropped (no interrupt)", async () => {
    const { host, manager } = setup()
    const task = await launch(manager, "parent_a")
    manager.detachParentSession("parent_a", false)
    expect(host.interrupted).not.toContain(task.sessionID)
    expect(manager.handleSessionIdle(task.sessionID)).toBeNull()
    expect(manager.listAllTasks().some((t) => t.id === task.id)).toBe(false)
  })

  test("detaching interrupts running children by default", async () => {
    const { host, manager } = setup({ neverResolvePrompt: true })
    const task = await launch(manager, "parent_d")
    manager.detachParentSession("parent_d")
    expect(host.interrupted).toContain(task.sessionID)
    expect(manager.listAllTasks().some((t) => t.id === task.id)).toBe(false)
  })

  test("detaching one parent does not affect another", async () => {
    const { manager } = setup()
    const a = await launch(manager, "parent_a")
    const b = await launch(manager, "parent_b")
    manager.detachParentSession("parent_a", false)
    manager.handleSessionIdle(a.sessionID)
    const n = manager.handleSessionIdle(b.sessionID)
    expect(n?.parentSessionID).toBe("parent_b")
  })
})

describe("claim / release lifecycle", () => {
  test("re-querying after markNotified returns null", async () => {
    const { manager } = setup()
    const a = await launch(manager, "s")
    const n = manager.handleSessionIdle(a.sessionID)
    manager.markNotified(n!.completedTasks)
    expect(manager.getCompletionStatusForSession("s")).toBeNull()
  })

  test("a claimed batch is invisible to a second caller and suppresses hasActiveBackgroundWork", async () => {
    const { manager } = setup()
    const a = await launch(manager, "s")
    expect(manager.hasActiveBackgroundWork("s")).toBe(true)
    manager.handleSessionIdle(a.sessionID)
    expect(manager.getCompletionStatusForSession("s")).toBeNull()
    expect(manager.hasActiveBackgroundWork("s")).toBe(true)
  })

  test("releaseClaim makes the batch available again (self-heal)", async () => {
    const { manager } = setup()
    const a = await launch(manager, "s")
    const n = manager.handleSessionIdle(a.sessionID)
    manager.releaseClaim(n!.completedTasks)
    expect(manager.hasActiveBackgroundWork("s")).toBe(false)
    const retry = manager.getCompletionStatusForSession("s")
    expect(retry?.allComplete).toBe(true)
    expect(retry?.completedTasks.map((t) => t.id)).toEqual([a.id])
  })

  test("partial then final lists every task exactly once", async () => {
    const { manager } = setup()
    const a = await launch(manager, "s", "a")
    const b = await launch(manager, "s", "b")
    expect(manager.handleSessionIdle(a.sessionID)?.allComplete).toBe(false)
    const final = manager.handleSessionIdle(b.sessionID)
    expect(final?.completedTasks.map((t) => t.id).sort()).toEqual([a.id, b.id].sort())
    manager.markNotified(final!.completedTasks)
    expect(manager.getCompletionStatusForSession("s")).toBeNull()
  })

  test("cancelled tasks are annotated; nothing-to-fetch wording when none completed", async () => {
    const { manager } = setup()
    const a = await launch(manager, "s", "a")
    await manager.cancel(a.id)
    const n = manager.getCompletionStatusForSession("s")
    expect(n?.message).toContain("— cancelled")
    expect(n?.message).toContain("Handle this work yourself")
    expect(n?.message).not.toContain("background_output")
  })

  test("a mixed wave still points at real results", async () => {
    const { manager } = setup()
    const a = await launch(manager, "s", "a")
    const b = await launch(manager, "s", "b")
    await manager.cancel(b.id)
    const n = manager.handleSessionIdle(a.sessionID)
    expect(n?.message).toContain("background_output")
    expect(n?.message).toContain(`- ${a.id}: a (explorer)\n`)
    expect(n?.message).toContain("— cancelled")
  })

  test("hasActiveBackgroundWork is false with no tasks", () => {
    expect(setup().manager.hasActiveBackgroundWork("none")).toBe(false)
  })
})

describe("cancel", () => {
  test("status flips before interrupt resolves so a late idle is ignored", async () => {
    let resolveInterrupt: () => void = () => {}
    const { manager } = setup({
      neverResolvePrompt: true,
      interrupt: () => new Promise<void>((r) => (resolveInterrupt = r)),
    })
    const task = await launch(manager, "s")
    const pending = manager.cancel(task.id)
    expect(manager.getTask(task.id)?.status).toBe("cancelled")
    expect(manager.handleSessionIdle(task.sessionID)).toBeNull()
    resolveInterrupt()
    expect(await pending).toBe(true)
  })

  test("returns true even if interrupt rejects", async () => {
    const { manager } = setup({
      neverResolvePrompt: true,
      interrupt: async () => {
        throw new Error("already gone")
      },
    })
    const task = await launch(manager, "s")
    expect(await manager.cancel(task.id)).toBe(true)
  })

  test("background_cancel on the last task returns the ALL COMPLETE message", async () => {
    const { manager } = setup({ neverResolvePrompt: true })
    const task = await launch(manager, "s")
    const out = await cancelBackgroundTask(manager, task.id, "s")
    expect(out).toContain("has been cancelled")
    expect(out).toContain("ALL BACKGROUND TASKS COMPLETE")
    expect(manager.hasActiveBackgroundWork("s")).toBe(false)
  })

  test("background_cancel on one of several does not claim all-complete", async () => {
    const { manager } = setup({ neverResolvePrompt: true })
    const a = await launch(manager, "s", "a")
    await launch(manager, "s", "b")
    const out = await cancelBackgroundTask(manager, a.id, "s")
    expect(out).not.toContain("ALL BACKGROUND TASKS COMPLETE")
  })

  test("unknown task cannot be cancelled", async () => {
    const { manager } = setup()
    expect(await cancelBackgroundTask(manager, "bg_nope", "s")).toContain("Could not cancel")
  })
})

describe("output and tool text", () => {
  test("background_output returns the last assistant message text", async () => {
    const { manager } = setup({
      messages: async () => [
        { role: "other", texts: [] },
        { role: "assistant", texts: ["first"] },
        { role: "assistant", texts: ["final", "answer"] },
      ],
    })
    const task = await launch(manager, "s")
    expect(await manager.getOutput(task.id)).toContain("still running")
    manager.handleSessionIdle(task.sessionID)
    expect(await manager.getOutput(task.id)).toBe("final\nanswer")
  })

  test("background_output reports missing and empty output", async () => {
    const { manager } = setup()
    expect(await manager.getOutput("bg_missing")).toBe("Task bg_missing not found")
    const task = await launch(manager, "s")
    manager.handleSessionIdle(task.sessionID)
    expect(await manager.getOutput(task.id)).toContain("no output found")
  })

  test("launch tool text and limit messages", async () => {
    const { manager } = setup()
    manager.setLimits({ maxConcurrent: 1 })
    const ok = await launchBackgroundTask(manager, { agent: "explorer", description: "d", prompt: "p" }, "s")
    expect(ok).toContain("Background task launched successfully.")
    const limited = await launchBackgroundTask(manager, { agent: "explorer", description: "d", prompt: "p" }, "s")
    expect(limited).toContain("Concurrency limit reached")
  })

  test("background_list is scoped to the calling session", async () => {
    const { manager } = setup()
    await launch(manager, "mine", "my task")
    await launch(manager, "other", "their task")
    const out = listBackgroundTasks(manager, "mine")
    expect(out).toContain("my task")
    expect(out).not.toContain("their task")
    expect(listBackgroundTasks(manager, "empty")).toBe("No background tasks launched by this session.")
  })
})
