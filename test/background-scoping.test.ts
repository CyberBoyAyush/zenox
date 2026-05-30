import { describe, expect, test } from "bun:test"
import { BackgroundManager } from "../src/background"
import type { OpencodeClient } from "@opencode-ai/sdk"

function createMockClient(): OpencodeClient {
  let counter = 0
  return {
    session: {
      create: async () => ({ data: { id: `child_${++counter}` } }),
      prompt: async () => ({ data: {} }),
      abort: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
    },
  } as unknown as OpencodeClient
}

function launch(manager: BackgroundManager, client: OpencodeClient, parentSessionID: string, description = "t") {
  return manager.launch(client, { agent: "explorer", description, prompt: "p", parentSessionID })
}

describe("background notification scoping (PR #3 regression)", () => {
  test("completion notifications are scoped to the originating parent session", async () => {
    const manager = new BackgroundManager()
    const client = createMockClient()

    const taskA = await launch(manager, client, "parent_a", "task a")
    const taskB = await launch(manager, client, "parent_b", "task b")

    // parent_a's task completes -> notification must only mention parent_a's task.
    const notification = manager.handleSessionIdle(taskA.sessionID)

    expect(notification).not.toBeNull()
    expect(notification?.parentSessionID).toBe("parent_a")
    expect(notification?.allComplete).toBe(true) // parent_a has no other tasks
    expect(notification?.completedTasks.map((t) => t.id)).toEqual([taskA.id])
    expect(notification?.message.includes(taskA.id)).toBe(true)
    // The other session's task must NOT bleed into this notification.
    expect(notification?.message.includes(taskB.id)).toBe(false)
  })

  test("running count is tracked per parent session, not globally", async () => {
    const manager = new BackgroundManager()
    const client = createMockClient()

    const a1 = await launch(manager, client, "parent_a", "a1")
    const a2 = await launch(manager, client, "parent_a", "a2")
    await launch(manager, client, "parent_b", "b1")

    const first = manager.handleSessionIdle(a1.sessionID)
    expect(first?.parentSessionID).toBe("parent_a")
    expect(first?.allComplete).toBe(false)
    expect(first?.runningCount).toBe(1) // a2 still running; parent_b's task ignored

    const second = manager.handleSessionIdle(a2.sessionID)
    expect(second?.allComplete).toBe(true)
    expect(second?.completedTasks.map((t) => t.id).sort()).toEqual([a1.id, a2.id].sort())
  })

  test("deleted parent session: completions are silenced, tasks dropped", async () => {
    const manager = new BackgroundManager()
    const client = createMockClient()

    const task = await launch(manager, client, "parent_a")
    manager.detachParentSession("parent_a")

    // Running task remains until it completes.
    expect(manager.listAllTasks().some((t) => t.id === task.id)).toBe(true)

    const notification = manager.handleSessionIdle(task.sessionID)
    expect(notification).toBeNull() // silenced
    expect(manager.listAllTasks().some((t) => t.id === task.id)).toBe(false) // dropped
  })

  test("detaching one session does not affect another session's tasks", async () => {
    const manager = new BackgroundManager()
    const client = createMockClient()

    const a = await launch(manager, client, "parent_a")
    const b = await launch(manager, client, "parent_b")
    manager.detachParentSession("parent_a")

    // parent_b's completion still notifies normally.
    manager.handleSessionIdle(a.sessionID) // silenced
    const notif = manager.handleSessionIdle(b.sessionID)
    expect(notif).not.toBeNull()
    expect(notif?.parentSessionID).toBe("parent_b")
    expect(notif?.completedTasks.map((t) => t.id)).toEqual([b.id])
  })

  test("partial notification names the task that JUST finished, not insertion order (F2)", async () => {
    const manager = new BackgroundManager()
    const client = createMockClient()

    // Insertion order A, B, C all in the same session.
    const a = await launch(manager, client, "p", "task a")
    const b = await launch(manager, client, "p", "task b")
    await launch(manager, client, "p", "task c")

    // C finishes first (partial) -> names C.
    const n1 = manager.handleSessionIdle(c_session(manager, "task c"))
    expect(n1?.allComplete).toBe(false)
    expect(n1?.message).toContain("task c")

    // A finishes second while B still running (partial branch). Insertion order
    // would wrongly pick C; the fix must name A.
    const n2 = manager.handleSessionIdle(a.sessionID)
    expect(n2?.allComplete).toBe(false)
    expect(n2?.message).toContain("task a")
    expect(n2?.message).not.toContain("task c")

    // sanity: b is still running
    expect(b.status).toBe("running")
  })

  test("failed launch pushes a completion notification to the parent (F1)", async () => {
    const manager = new BackgroundManager()
    // Client whose prompt() rejects -> task is marked failed in continueLaunch.
    const failingClient = {
      session: {
        create: async () => ({ data: { id: "child_fail" } }),
        prompt: async () => {
          throw new Error("boom: backend rejected")
        },
        abort: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
      },
    } as unknown as OpencodeClient

    const notifications: string[] = []
    manager.setCompletionNotifier((n) => notifications.push(n.parentSessionID))

    await launch(manager, failingClient, "parent_x", "doomed")
    // sendPrompt is fire-and-forget; let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 20))

    expect(notifications).toContain("parent_x")
  })
})

/** Helper: find the child sessionID for a task by its description. */
function c_session(manager: BackgroundManager, description: string): string {
  const task = manager.listAllTasks().find((t) => t.description === description)
  if (!task) throw new Error(`no task with description ${description}`)
  return task.sessionID
}
