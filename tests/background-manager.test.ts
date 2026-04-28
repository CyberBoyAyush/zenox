import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { BackgroundManager } from "../src/background/manager"

function createMockClient(): OpencodeClient {
  let counter = 0

  const client = {
    session: {
      create: async () => ({ data: { id: `child_${++counter}` } }),
      prompt: async () => ({ data: {} }),
      abort: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
    },
  }

  return client as unknown as OpencodeClient
}

describe("BackgroundManager session scoping", () => {
  test("keeps completion notifications scoped to parent session", async () => {
    const manager = new BackgroundManager()
    const client = createMockClient()

    const taskA = await manager.launch(client, {
      agent: "explorer",
      description: "task a",
      prompt: "prompt a",
      parentSessionID: "parent_a",
    })

    const taskB = await manager.launch(client, {
      agent: "explorer",
      description: "task b",
      prompt: "prompt b",
      parentSessionID: "parent_b",
    })

    const notification = manager.handleSessionIdle(taskA.sessionID)

    expect(notification).not.toBeNull()
    expect(notification?.parentSessionID).toBe("parent_a")
    expect(notification?.allComplete).toBe(true)
    expect(notification?.completedTasks.map((t) => t.id)).toEqual([taskA.id])
    expect(notification?.message.includes(taskA.id)).toBe(true)
    expect(notification?.message.includes(taskB.id)).toBe(false)
  })

  test("tracks running count per parent session", async () => {
    const manager = new BackgroundManager()
    const client = createMockClient()

    const taskA1 = await manager.launch(client, {
      agent: "explorer",
      description: "task a1",
      prompt: "prompt a1",
      parentSessionID: "parent_a",
    })

    const taskA2 = await manager.launch(client, {
      agent: "explorer",
      description: "task a2",
      prompt: "prompt a2",
      parentSessionID: "parent_a",
    })

    const taskB = await manager.launch(client, {
      agent: "explorer",
      description: "task b",
      prompt: "prompt b",
      parentSessionID: "parent_b",
    })

    const first = manager.handleSessionIdle(taskA1.sessionID)
    expect(first).not.toBeNull()
    expect(first?.parentSessionID).toBe("parent_a")
    expect(first?.allComplete).toBe(false)
    expect(first?.runningCount).toBe(1)
    expect(first?.completedTasks.map((t) => t.id)).toEqual([taskA1.id])

    const second = manager.handleSessionIdle(taskA2.sessionID)
    expect(second).not.toBeNull()
    expect(second?.parentSessionID).toBe("parent_a")
    expect(second?.allComplete).toBe(true)
    expect(second?.completedTasks.map((t) => t.id).sort()).toEqual(
      [taskA1.id, taskA2.id].sort()
    )
    expect(second?.completedTasks.map((t) => t.id).includes(taskB.id)).toBe(false)
  })

  test("detached parent session suppresses notifications and keeps running tasks until completion", async () => {
    const manager = new BackgroundManager()
    const client = createMockClient()

    const task = await manager.launch(client, {
      agent: "explorer",
      description: "task",
      prompt: "prompt",
      parentSessionID: "parent_a",
    })

    manager.detachParentSession("parent_a")

    expect(manager.listAllTasks().some((t) => t.id === task.id)).toBe(true)

    const notification = manager.handleSessionIdle(task.sessionID)
    expect(notification).toBeNull()
    expect(manager.listAllTasks().some((t) => t.id === task.id)).toBe(false)
  })
})
