import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  explorerAgent,
  librarianAgent,
  oracleAgent,
  uiPlannerAgent,
  inspectorAgent,
  READ_ONLY_PERMISSIONS,
} from "../src/agents"
import { ZenoxConfigSchema } from "../src/config"
import { ORCHESTRATION_PROMPT } from "../src/orchestration/prompt"

const denied = (rules: readonly { action: string; effect: string }[]) =>
  rules.filter((r) => r.effect === "deny").map((r) => r.action)

describe("permission policy hardening", () => {
  test("READ_ONLY_PERMISSIONS denies edit, shell and both recursion paths explicitly", () => {
    expect(denied(READ_ONLY_PERMISSIONS)).toEqual(["edit", "shell", "subagent", "background_task"])
    for (const rule of READ_ONLY_PERMISSIONS) expect(rule.resource).toBe("*")
  })

  test("explorer, librarian, oracle use the shared read-only policy", () => {
    for (const agent of [explorerAgent, librarianAgent, oracleAgent]) {
      expect(agent.permissions).toEqual(READ_ONLY_PERMISSIONS)
    }
  })

  test("ui-planner can edit and run the shell but cannot recurse", () => {
    expect(denied(uiPlannerAgent.permissions)).toEqual(["subagent", "background_task"])
  })

  test("inspector can run the shell but never edit", () => {
    expect(denied(inspectorAgent.permissions)).toEqual(["edit", "subagent", "background_task"])
  })
})

describe("inspector agent", () => {
  test("has a structured verdict contract and escalation rule", () => {
    expect(inspectorAgent.system).toContain("PASS | PARTIAL | FAIL | BLOCKED")
    expect(inspectorAgent.system).toContain("stable failure signature")
    expect(inspectorAgent.system).toContain("escalate to oracle")
    expect(inspectorAgent.system).toContain("Never edit, write, or fix")
    expect(inspectorAgent.system).toContain("shell tool")
  })

  test("is a subagent with its model", () => {
    expect(inspectorAgent.mode).toBe("subagent")
    expect(inspectorAgent.model).toBe("anthropic/claude-sonnet-5")
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
