import { describe, expect, test } from "bun:test"
import { BackgroundManager, BackgroundLimitError, DEFAULT_BACKGROUND_LIMITS } from "../src/background"
import type { OpencodeClient } from "@opencode-ai/sdk"

/**
 * Minimal client stub: session.create returns a unique id, session.prompt is a
 * no-op that never resolves the underlying "session.idle", so launched tasks
 * stay in the "running" state (which is what we want to count concurrency).
 */
function createClientStub(): OpencodeClient {
  let counter = 0
  return {
    session: {
      create: async () => ({ data: { id: `sess-${++counter}` } }),
      prompt: async () => ({ data: {} }),
    },
  } as unknown as OpencodeClient
}

async function launch(manager: BackgroundManager, client: OpencodeClient, parentSessionID: string) {
  return manager.launch(client, {
    agent: "explorer",
    description: "test",
    prompt: "test",
    parentSessionID,
  })
}

describe("background concurrency limits", () => {
  test("default limits are 6 concurrent / 50 per session", () => {
    expect(DEFAULT_BACKGROUND_LIMITS.maxConcurrent).toBe(6)
    expect(DEFAULT_BACKGROUND_LIMITS.maxPerSession).toBe(50)
  })

  test("rejects launches beyond max_concurrent", async () => {
    const manager = new BackgroundManager()
    manager.setLimits({ maxConcurrent: 3, maxPerSession: 100 })
    const client = createClientStub()
    const session = "main-1"

    // Fill up the 3 running slots
    for (let i = 0; i < 3; i++) {
      expect(manager.checkLaunchAllowed(session)).toBeNull()
      await launch(manager, client, session)
    }

    // 4th must be rejected (still 3 running)
    const rejection = manager.checkLaunchAllowed(session)
    expect(rejection).not.toBeNull()
    expect(rejection).toContain("Concurrency limit")
    expect(manager.listActiveTasks().length).toBe(3)
  })

  test("launch() itself throws BackgroundLimitError beyond max_concurrent (authoritative)", async () => {
    const manager = new BackgroundManager()
    manager.setLimits({ maxConcurrent: 2, maxPerSession: 100 })
    const client = createClientStub()
    const session = "main-auth"

    await launch(manager, client, session)
    await launch(manager, client, session)

    // Even without calling checkLaunchAllowed first, launch must reject.
    await expect(launch(manager, client, session)).rejects.toBeInstanceOf(BackgroundLimitError)
    expect(manager.listActiveTasks().length).toBe(2)
  })

  test("circuit breaker rejects beyond max_per_session even when nothing is running", async () => {
    const manager = new BackgroundManager()
    manager.setLimits({ maxConcurrent: 100, maxPerSession: 2 })
    const client = createClientStub()
    const session = "main-2"

    await launch(manager, client, session)
    await launch(manager, client, session)

    const rejection = manager.checkLaunchAllowed(session)
    expect(rejection).not.toBeNull()
    expect(rejection).toContain("circuit breaker")
    await expect(launch(manager, client, session)).rejects.toBeInstanceOf(BackgroundLimitError)
  })

  test("per-session spawn count is isolated between sessions", async () => {
    const manager = new BackgroundManager()
    manager.setLimits({ maxConcurrent: 100, maxPerSession: 1 })
    const client = createClientStub()

    await launch(manager, client, "session-a")
    // session-a is now capped, but session-b is fresh
    expect(manager.checkLaunchAllowed("session-a")).not.toBeNull()
    expect(manager.checkLaunchAllowed("session-b")).toBeNull()
  })

  test("setLimits ignores undefined and keeps existing values", () => {
    const manager = new BackgroundManager()
    manager.setLimits({ maxConcurrent: 10 })
    expect(manager.getLimits().maxConcurrent).toBe(10)
    expect(manager.getLimits().maxPerSession).toBe(DEFAULT_BACKGROUND_LIMITS.maxPerSession)
    manager.setLimits(undefined)
    expect(manager.getLimits().maxConcurrent).toBe(10)
  })

  test("concurrent launches cannot overshoot max_concurrent (TOCTOU)", async () => {
    const manager = new BackgroundManager()
    manager.setLimits({ maxConcurrent: 3, maxPerSession: 100 })
    // Client whose session.create is slow, so all launches are in-flight at once.
    let counter = 0
    const slowClient = {
      session: {
        create: async () => {
          await new Promise((r) => setTimeout(r, 10))
          return { data: { id: `sess-${++counter}` } }
        },
        prompt: async () => ({ data: {} }),
      },
    } as unknown as OpencodeClient

    const session = "burst"
    // Fire 10 launches simultaneously; launch() enforces the cap atomically and
    // rejects the overflow. Swallow rejections.
    const attempts = Array.from({ length: 10 }, () =>
      launch(manager, slowClient, session).catch(() => null)
    )
    await Promise.all(attempts)

    // Atomic admission must keep us at or below the cap.
    expect(manager.listActiveTasks().length).toBeLessThanOrEqual(3)
  })

  test("long-running tasks keep their concurrency slot until completion (no timeout)", async () => {
    const manager = new BackgroundManager()
    manager.setLimits({ maxConcurrent: 2, maxPerSession: 100 })
    const client = createClientStub()
    const session = "long-runner"

    // Two long-running tasks fill the slots. They never auto-complete here,
    // simulating a 5-6 minute subagent run.
    const t1 = await launch(manager, client, session)
    await launch(manager, client, session)
    expect(manager.listActiveTasks().length).toBe(2)

    // A third launch must still be rejected — the slots are held for the
    // ENTIRE duration of the running tasks, however long that is.
    await expect(launch(manager, client, session)).rejects.toBeInstanceOf(BackgroundLimitError)

    // Simulate one task finishing (session.idle path) — slot frees up.
    manager.handleSessionIdle(t1.sessionID)
    expect(manager.listActiveTasks().length).toBe(1)
    // Now a new launch is admitted.
    const t3 = await launch(manager, client, session)
    expect(t3.status).toBe("running")
  })

  test("dispose clears all state", async () => {
    const manager = new BackgroundManager()
    const client = createClientStub()
    await launch(manager, client, "main-3")
    expect(manager.listActiveTasks().length).toBe(1)
    manager.dispose()
    expect(manager.listAllTasks().length).toBe(0)
    expect(manager.getMainSession()).toBeUndefined()
  })
})
