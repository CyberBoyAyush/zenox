import { describe, expect, test } from "bun:test"
import plugin from "../src/index"
import { setupZenox } from "../src/plugin"
import type { ZenoxConfig } from "../src/config"
import { createFakeContext, type FakeContextOptions } from "./fake-context"

async function start(config: ZenoxConfig = {}, options: FakeContextOptions = {}) {
  const fake = createFakeContext(options)
  const cleanup = await setupZenox(fake.ctx, { config })
  await fake.flush()
  return Object.assign(fake, { cleanup })
}

describe("plugin definition", () => {
  test("default export is a V2 plugin definition with a stable id", () => {
    expect(plugin.id).toBe("zenox")
    expect(typeof plugin.setup).toBe("function")
  })
})

describe("agents", () => {
  test("registers all five subagents with V2 fields", async () => {
    const z = await start()
    expect([...z.agents.keys()].sort()).toEqual(
      ["explorer", "inspector", "librarian", "oracle", "ui-planner"].sort()
    )
    const explorer = z.agents.get("explorer")!
    expect(explorer.mode).toBe("subagent")
    expect(explorer.system).toContain("codebase search specialist")
    expect(explorer.color).toBe("#3B82F6")
    expect(explorer.model).toEqual({ providerID: "anthropic", id: "claude-haiku-4-5" })
    await z.cleanup()
  })

  test("oracle keeps its built-in variant as model#variant", async () => {
    const z = await start()
    expect(z.agents.get("oracle")!.model).toEqual({
      providerID: "openai",
      id: "gpt-6.1-sol",
      variant: "medium",
    })
    await z.cleanup()
  })

  test("permissions: read-only agents deny edit/shell/recursion; inspector keeps shell; ui-planner keeps edit", async () => {
    const z = await start()
    const actions = (name: string) =>
      z.agents.get(name)!.permissions.filter((p) => p.effect === "deny").map((p) => p.action)
    for (const name of ["explorer", "librarian", "oracle"]) {
      expect(actions(name)).toEqual(["edit", "shell", "subagent", "background_task"])
    }
    expect(actions("inspector")).toEqual(["edit", "subagent", "background_task"])
    expect(actions("ui-planner")).toEqual(["subagent", "background_task"])
    await z.cleanup()
  })

  test("Zenox rules are appended after existing rules so they win", async () => {
    const z = await start({}, {
      existingAgents: {
        explorer: { permissions: [{ action: "edit", resource: "*", effect: "allow" }] },
      },
    })
    const perms = z.agents.get("explorer")!.permissions
    expect(perms[0]).toEqual({ action: "edit", resource: "*", effect: "allow" })
    expect(perms.at(-1)?.effect).toBe("deny")
    await z.cleanup()
  })

  test("new agents inherit the build agent's rules (user globals) before Zenox restrictions", async () => {
    const globalRule = { action: "webfetch", resource: "*", effect: "ask" }
    const z = await start({}, {
      existingAgents: { build: { permissions: [globalRule] } },
    })
    const perms = z.agents.get("oracle")!.permissions
    expect(perms[0]).toEqual(globalRule)
    expect(perms.slice(1).every((p) => p.effect === "deny")).toBe(true)
    // A snapshot, not a shared reference.
    expect(perms[0]).not.toBe(z.agents.get("build")!.permissions[0])
    expect(z.agents.get("build")!.permissions).toEqual([globalRule])
    await z.cleanup()
  })

  test("zenox.json model/variant overrides and disabled agents apply", async () => {
    const z = await start({
      agents: {
        explorer: { model: "openai/gpt-5-mini", variant: "high" },
        oracle: { variant: "xhigh" },
      },
      disabled_agents: ["ui-planner"],
    })
    expect(z.agents.get("explorer")!.model).toEqual({
      providerID: "openai",
      id: "gpt-5-mini",
      variant: "high",
    })
    expect(z.agents.get("oracle")!.model?.variant).toBe("xhigh")
    expect(z.agents.has("ui-planner")).toBe(false)
    await z.cleanup()
  })
})

describe("MCP servers and skills", () => {
  test("registers MCP servers in V2 shape, honoring disabled_mcps", async () => {
    const z = await start({ disabled_mcps: ["exa"] })
    expect(z.mcps.has("exa")).toBe(false)
    expect(z.mcps.get("grep_app")).toEqual({ type: "remote", url: "https://mcp.grep.app", disabled: false })
    expect(z.mcps.get("sequential-thinking")).toMatchObject({ type: "local", disabled: false })
    await z.cleanup()
  })

  test("registers bundled skills in memory without overriding user skills", async () => {
    const z = await start({}, { existingSkills: ["grill-me"] })
    const frontend = z.skills.get("frontend-design")!
    expect(frontend.name).toBe("frontend-design")
    expect(frontend.description).toContain("frontend")
    expect(frontend.path).toEndWith("skills/frontend-design/SKILL.md")
    expect(frontend.content).not.toStartWith("---")
    expect(z.skills.get("grill-me")!.content).toBe("user")
    await z.cleanup()
  })

  test("disabled_skills are not registered", async () => {
    const z = await start({ disabled_skills: ["frontend-design"] })
    expect(z.skills.has("frontend-design")).toBe(false)
    expect(z.skills.has("grill-me")).toBe(true)
    await z.cleanup()
  })
})

describe("tools", () => {
  test("registers background + guideline tools and drops unsupported V1 tools", async () => {
    const z = await start()
    expect([...z.tools.keys()].sort()).toEqual(
      [
        "background_cancel",
        "background_list",
        "background_output",
        "background_task",
        "save_project_guideline",
      ].sort()
    )
    for (const dropped of ["find_symbols", "lsp_status", "session_list", "session_search"]) {
      expect(z.tools.has(dropped)).toBe(false)
    }
    await z.cleanup()
  })

  test("tool inputs are plain JSON Schema and invalid input is rejected", async () => {
    const z = await start()
    expect(z.tools.get("background_task")!.input).toEqual({
      type: "object",
      properties: {
        agent: expect.objectContaining({ type: "string" }),
        description: expect.objectContaining({ type: "string" }),
        prompt: expect.objectContaining({ type: "string" }),
      },
      required: ["agent", "description", "prompt"],
      additionalProperties: false,
    })
    expect(await z.callTool("background_output", {}, { sessionID: "s" })).toContain(
      "Invalid input for background_output"
    )
    await z.cleanup()
  })
})

describe("session hooks", () => {
  test("prompt hook appends keyword context once per session and emits a toast", async () => {
    const z = await start()
    const event = { sessionID: "s1", prompt: { text: "ultrawork: fix the bug" } }
    z.runSessionHook("prompt", event)
    expect(event.prompt.text).toStartWith("ultrawork: fix the bug\n\n")
    expect(event.prompt.text).toContain("ULTRAWORK MODE ACTIVE")
    expect(z.toasts.at(-1)?.title).toBe("⚡ Ultrawork Mode")

    const again = { sessionID: "s1", prompt: { text: "ultrawork again" } }
    z.runSessionHook("prompt", again)
    expect(again.prompt.text).toBe("ultrawork again")
    expect(z.toasts.length).toBe(1)
    await z.cleanup()
  })

  test("keywords inside code are ignored", async () => {
    const z = await start()
    const event = { sessionID: "s2", prompt: { text: "look at `ultrawork` flag" } }
    z.runSessionHook("prompt", event)
    expect(event.prompt.text).toBe("look at `ultrawork` flag")
    await z.cleanup()
  })

  test("context hook injects the orchestration prompt for build/plan only", async () => {
    const z = await start({ disabled_agents: ["oracle"] })
    const build = { agent: "build", system: [] as Array<{ type: string; text: string }> }
    z.runSessionHook("context", build)
    expect(build.system).toHaveLength(1)
    expect(build.system[0]?.text).toContain("## Sub-Agent Delegation")
    expect(build.system[0]?.text).toContain("## Disabled Agents")

    const oracle = { agent: "oracle", system: [] as Array<{ type: string; text: string }> }
    z.runSessionHook("context", oracle)
    expect(oracle.system).toHaveLength(0)
    await z.cleanup()
  })
})

describe("background tasks end-to-end", () => {
  const launch = (z: Awaited<ReturnType<typeof start>>, description: string, sessionID = "parent") =>
    z.callTool("background_task", { agent: "explorer", description, prompt: description }, { sessionID })

  test("launch creates a real child session; completion (via session.wait) resumes the parent", async () => {
    const z = await start()
    const out = await launch(z, "find auth")
    expect(out).toContain("launched successfully")
    expect(z.created[0]).toMatchObject({ parentID: "parent", agent: "explorer" })
    expect(z.created[0]?.permissions).toEqual([
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "background_task", resource: "*", effect: "deny" },
    ])
    expect(z.prompts[0]).toEqual({ sessionID: "child_1", text: "find auth" })

    await z.finish("child_1")
    expect(z.notices).toHaveLength(1)
    expect(z.notices[0]).toMatchObject({ sessionID: "parent", resume: true })
    expect(z.notices[0]?.text).toContain("[ALL BACKGROUND TASKS COMPLETE]")
    const taskId = out.match(/bg_\w+/)![0]
    expect(await z.callTool("background_output", { task_id: taskId }, { sessionID: "parent" })).toBe("done child_1")
    expect(z.toasts.some((t) => t.title === "⚡ Background Task Launched")).toBe(true)
    expect(z.toasts.some((t) => t.title === "🎉 All Background Tasks Complete")).toBe(true)
    await z.cleanup()
  })

  test("works even when the plugin event stream delivers nothing", async () => {
    const z = await start({}, { silentEvents: true })
    await launch(z, "x")
    await z.finish("child_1")
    expect(z.notices[0]?.text).toContain("ALL BACKGROUND TASKS COMPLETE")
    await z.cleanup()
  })

  test("a redundant session.idle event does not duplicate the notice", async () => {
    const z = await start()
    await launch(z, "x")
    await z.finish("child_1")
    await z.emit({ type: "session.idle", data: { sessionID: "child_1" } })
    expect(z.notices).toHaveLength(1)
    await z.cleanup()
  })

  test("partial completion is delivered without resuming the parent", async () => {
    const z = await start()
    await launch(z, "a", "p")
    await launch(z, "b", "p")
    await z.finish("child_1")
    expect(z.notices[0]).toMatchObject({ sessionID: "p", resume: false })
    expect(z.notices[0]?.text).toContain("1 task(s) still running")
    await z.cleanup()
  })

  test("notices are not treated as user keywords", async () => {
    const z = await start()
    const event = { sessionID: "p", prompt: { text: "<system-reminder>\nultrawork deep research\n</system-reminder>" } }
    z.runSessionHook("prompt", event)
    expect(event.prompt.text).not.toContain("ULTRAWORK MODE")
    expect(z.toasts).toHaveLength(0)
    await z.cleanup()
  })

  test("a failed delivery is retried when the parent goes idle", async () => {
    const z = await start({}, { failPrompt: { match: "ALL BACKGROUND TASKS COMPLETE", times: 1 } })
    await launch(z, "x", "p")
    await z.finish("child_1")
    expect(z.notices).toHaveLength(0)

    await z.emit({ type: "session.idle", data: { sessionID: "p" } })
    expect(z.notices).toHaveLength(1)
    expect(z.notices[0]?.text).toContain("ALL BACKGROUND TASKS COMPLETE")
    await z.cleanup()
  })

  test("deleting the parent interrupts its running children", async () => {
    const z = await start()
    await launch(z, "x", "p")
    await z.emit({ type: "session.deleted", data: { sessionID: "p" } })
    expect(z.interrupted).toContain("child_1")
    await z.finish("child_1")
    expect(z.notices).toHaveLength(0)
    await z.cleanup()
  })

  test("todo tooling is gone (V2 has no todo tool)", async () => {
    const z = await start()
    expect(z.toolHooks.has("execute.after")).toBe(false)
    await z.cleanup()
  })
})

describe("lifecycle", () => {
  test("cleanup stops the event stream", async () => {
    const z = await start()
    expect(z.subscriptions).toBe(1)
    await z.cleanup()
    expect(z.aborted).toBe(true)
  })
})
