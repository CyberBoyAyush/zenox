import { describe, expect, test } from "bun:test"
import { createBackgroundSessionHost, parseModelRef, toMessageTexts } from "../src/host/v2"

type Session = Parameters<typeof createBackgroundSessionHost>[0]

const assistant = (text: string) => ({ type: "assistant", content: [{ type: "text", text }] })

function fakeSession(overrides: { wait?: () => Promise<void>; context?: () => Promise<unknown[]> }) {
  const calls = { wait: 0, context: 0 }
  const session = {
    create: async () => ({ id: "child" }),
    prompt: async () => ({}),
    interrupt: async () => ({}),
    wait: async () => {
      calls.wait++
      await overrides.wait?.()
    },
    context: async () => {
      calls.context++
      return overrides.context ? overrides.context() : []
    },
  } as unknown as Session
  return { session, calls }
}

describe("V2 host: waitForCompletion", () => {
  test("keeps waiting when wait returns before the child produced output", async () => {
    let contextCalls = 0
    const { session, calls } = fakeSession({
      context: async () => (++contextCalls >= 3 ? [assistant("done")] : []),
    })
    const host = createBackgroundSessionHost(session, { retryDelayMs: 1 })
    await host.waitForCompletion("child", () => true)
    expect(calls.wait).toBe(3)
  })

  test("retries transient wait errors instead of failing", async () => {
    let attempts = 0
    const { session } = fakeSession({
      wait: async () => {
        if (++attempts === 1) throw new Error("network blip")
      },
      context: async () => [assistant("done")],
    })
    const host = createBackgroundSessionHost(session, { retryDelayMs: 1 })
    await host.waitForCompletion("child", () => true)
    expect(attempts).toBe(2)
  })

  test("stops as soon as the task is no longer active (cancel/timeout)", async () => {
    let active = true
    const { session, calls } = fakeSession({
      wait: async () => {
        active = false
      },
      context: async () => [],
    })
    const host = createBackgroundSessionHost(session, { retryDelayMs: 1 })
    await host.waitForCompletion("child", () => active)
    expect(calls.wait).toBe(1)
    expect(calls.context).toBe(0)
  })
})

describe("V2 host helpers", () => {
  test("toMessageTexts keeps only assistant text parts", () => {
    expect(
      toMessageTexts([
        { type: "user", content: [{ type: "text", text: "hi" }] },
        { type: "assistant", content: [{ type: "tool" }, { type: "text", text: "a" }, { type: "reasoning", text: "r" }] },
        { type: "assistant", content: [] },
      ])
    ).toEqual([
      { role: "other", texts: [] },
      { role: "assistant", texts: ["a"] },
      { role: "assistant", texts: [] },
    ])
  })

  test("parseModelRef handles variants and nested model IDs", () => {
    expect(parseModelRef("openai/gpt-5.6-sol#medium")).toEqual({ providerID: "openai", id: "gpt-5.6-sol", variant: "medium" })
    expect(parseModelRef("openrouter/anthropic/claude")).toEqual({ providerID: "openrouter", id: "anthropic/claude" })
    expect(parseModelRef("bad")).toBeUndefined()
  })
})
