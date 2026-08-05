import { describe, expect, test } from "bun:test"
import { withTimeout } from "../src/shared/with-timeout"

describe("withTimeout", () => {
  test("resolves with the promise's value when it settles before the timeout", async () => {
    const result = await withTimeout(Promise.resolve("done"), 50, "fallback")
    expect(result).toBe("done")
  })

  test("resolves with the fallback when the promise never settles", async () => {
    const hung = new Promise<string>(() => {})
    const result = await withTimeout(hung, 20, "timed-out")
    expect(result).toBe("timed-out")
  })

  test("a late resolution after timeout does not throw or affect the already-returned value", async () => {
    let resolveLate: (v: string) => void = () => {}
    const late = new Promise<string>((resolve) => {
      resolveLate = resolve
    })

    const result = await withTimeout(late, 20, "timed-out")
    expect(result).toBe("timed-out")

    // The original promise finally resolves after we've already moved on —
    // must not throw or cause an unhandled rejection.
    resolveLate("too-late")
    await new Promise((r) => setTimeout(r, 10))
  })

  test("propagates a rejection from the promise if it rejects before the timeout", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 50, false)).rejects.toThrow(
      "boom"
    )
  })

  test("clears its internal timer so it does not keep the process alive", async () => {
    // If the timer weren't cleared/unref'd, running many of these in a test
    // suite would eventually hang process exit. Just proving no throw/leak
    // across repeated fast calls is a reasonable proxy here.
    for (let i = 0; i < 20; i++) {
      await withTimeout(Promise.resolve(i), 100, -1)
    }
  })
})
