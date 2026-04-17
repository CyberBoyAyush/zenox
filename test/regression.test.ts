import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyAgentVariant, resolveAgentVariant, type VariantMessage } from "../src/shared"
import { explorerAgent, librarianAgent, oracleAgent } from "../src/agents"
import { loadPluginConfig } from "../src/config"
import {
  clearSessionAgent,
  getOrchestrationAgentType,
  getSessionAgent,
  getSessionContext,
  getSessionModel,
  setSessionContext,
} from "../src/orchestration/session-agent-tracker"
import { ORCHESTRATION_PROMPT } from "../src/orchestration/prompt"
import { createKeywordDetectorHook } from "../src/hooks"

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe("variant migration", () => {
  test("applyAgentVariant writes to message.model.variant", () => {
    const message: VariantMessage = {}

    applyAgentVariant(
      {
        agents: {
          explorer: { variant: "high" },
        },
      },
      "explorer",
      message,
    )

    expect(message.model?.variant).toBe("high")
  })

  test("applyAgentVariant preserves an existing nested variant", () => {
    const message: VariantMessage = {
      model: { variant: "existing" },
    }

    applyAgentVariant(
      {
        agents: {
          explorer: { variant: "high" },
        },
      },
      "explorer",
      message,
    )

    expect(message.model?.variant).toBe("existing")
  })

  test("resolveAgentVariant still reads configured overrides", () => {
    expect(
      resolveAgentVariant(
        {
          agents: {
            oracle: { variant: "xhigh" },
          },
        },
        "oracle",
      ),
    ).toBe("xhigh")
  })
})

describe("prompt regressions", () => {
  test("oracle defaults to gpt-5.4 high", () => {
    expect(oracleAgent.model).toBe("openai/gpt-5.4")
    expect(oracleAgent.variant).toBe("high")
  })

  test("orchestration prompt uses current tool names", () => {
    expect(ORCHESTRATION_PROMPT).toContain("`task` tool")
    expect(ORCHESTRATION_PROMPT).toContain("`todowrite`")
    expect(ORCHESTRATION_PROMPT).not.toContain("TodoWrite")
    expect(ORCHESTRATION_PROMPT).not.toContain("Task(")
  })

  test("explorer prompt only references available search tools", () => {
    expect(explorerAgent.prompt).toContain("grep_app_searchGitHub")
    expect(explorerAgent.prompt).not.toContain("ast_grep_search")
    expect(explorerAgent.prompt).not.toContain("3+ tools simultaneously")
  })

  test("librarian prompt avoids hard minimum call quotas", () => {
    expect(librarianAgent.prompt).toContain("PARALLEL EXECUTION GUIDANCE")
    expect(librarianAgent.prompt).not.toContain("Minimum Parallel Calls")
    expect(librarianAgent.prompt).not.toContain("Execute ALL in parallel (6+ calls)")
  })

  test("orchestration prompt still documents the actual background and session tools", () => {
    expect(ORCHESTRATION_PROMPT).toContain("background_task")
    expect(ORCHESTRATION_PROMPT).toContain("background_output")
    expect(ORCHESTRATION_PROMPT).toContain("session_list")
    expect(ORCHESTRATION_PROMPT).toContain("session_search")
    expect(ORCHESTRATION_PROMPT).toContain("find_symbols")
    expect(ORCHESTRATION_PROMPT).toContain("lsp_status")
  })
})

describe("config loading", () => {
  test("project config overrides user config and merges agents/disabled_agents", () => {
    const previousXdg = process.env.XDG_CONFIG_HOME
    const previousHome = process.env.HOME
    const userConfigHome = createTempDir("zenox-user-")
    const projectDir = createTempDir("zenox-project-")

    mkdirSync(join(userConfigHome, "opencode"), { recursive: true })
    writeFileSync(
      join(userConfigHome, "opencode", "zenox.json"),
      JSON.stringify(
        {
          agents: {
            explorer: { model: "anthropic/claude-haiku-4-5", variant: "low" },
            oracle: { variant: "medium" },
          },
          disabled_agents: ["oracle"],
          disabled_mcps: ["exa"],
        },
        null,
        2,
      ),
    )

    mkdirSync(join(projectDir, ".opencode"), { recursive: true })
    writeFileSync(
      join(projectDir, ".opencode", "zenox.json"),
      JSON.stringify(
        {
          agents: {
            explorer: { variant: "high" },
            librarian: { model: "anthropic/claude-sonnet-4-5" },
          },
          disabled_agents: ["ui-planner"],
          disabled_mcps: ["grep_app"],
        },
        null,
        2,
      ),
    )

    process.env.XDG_CONFIG_HOME = userConfigHome
    process.env.HOME = userConfigHome

    try {
      const config = loadPluginConfig(projectDir)

      expect(config.agents?.explorer?.variant).toBe("high")
      expect(config.agents?.explorer?.model).toBe("anthropic/claude-haiku-4-5")
      expect(config.agents?.librarian?.model).toBe("anthropic/claude-sonnet-4-5")
      expect(config.agents?.oracle?.variant).toBe("medium")
      expect(config.disabled_agents).toEqual(["oracle", "ui-planner"])
      expect(config.disabled_mcps).toEqual(["exa", "grep_app"])
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdg

      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome

      rmSync(userConfigHome, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})

describe("session tracking", () => {
  test("tracks and clears agent and model context", () => {
    const sessionID = "tracker-session"
    clearSessionAgent(sessionID)

    setSessionContext(sessionID, {
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-7" },
    })

    expect(getSessionAgent(sessionID)).toBe("build")
    expect(getSessionModel(sessionID)).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-7",
    })
    expect(getSessionContext(sessionID)).toEqual({
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-7" },
    })

    clearSessionAgent(sessionID)

    expect(getSessionContext(sessionID)).toBeUndefined()
  })

  test("maps orchestration agent types correctly", () => {
    expect(getOrchestrationAgentType("build")).toBe("build")
    expect(getOrchestrationAgentType("plan")).toBe("plan")
    expect(getOrchestrationAgentType("oracle")).toBe("oracle")
    expect(getOrchestrationAgentType(undefined)).toBeUndefined()
  })
})

describe("keyword detector", () => {
  test("injects a keyword context once per session and keyword set", async () => {
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

    const firstOutput = {
      parts: [{ type: "text", text: "please do deep research" }],
      message: {},
    }
    const secondOutput = {
      parts: [{ type: "text", text: "please do deep research" }],
      message: {},
    }

    await hook["chat.message"]?.({ sessionID: "keyword-session" }, firstOutput)
    await hook["chat.message"]?.({ sessionID: "keyword-session" }, secondOutput)

    expect(firstOutput.parts[0]?.text).toContain("DEEP RESEARCH MODE")
    expect(secondOutput.parts[0]?.text).toBe("please do deep research")
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toEqual({
      title: "🔬 Deep Research Mode",
      message: "Comprehensive exploration enabled. Background agents will fire.",
    })
  })

  test("re-injects keyword context for a different session", async () => {
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

    const firstSessionOutput = {
      parts: [{ type: "text", text: "please do deep research" }],
      message: {},
    }
    const secondSessionOutput = {
      parts: [{ type: "text", text: "please do deep research" }],
      message: {},
    }

    await hook["chat.message"]?.({ sessionID: "keyword-session-a" }, firstSessionOutput)
    await hook["chat.message"]?.({ sessionID: "keyword-session-b" }, secondSessionOutput)

    expect(firstSessionOutput.parts[0]?.text).toContain("DEEP RESEARCH MODE")
    expect(secondSessionOutput.parts[0]?.text).toContain("DEEP RESEARCH MODE")
    expect(toasts).toHaveLength(2)
  })

  test("injects different keyword contexts within the same session", async () => {
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

    const deepResearchOutput = {
      parts: [{ type: "text", text: "please do deep research" }],
      message: {},
    }
    const reviewOutput = {
      parts: [{ type: "text", text: "please review this implementation" }],
      message: {},
    }

    await hook["chat.message"]?.({ sessionID: "keyword-session-mixed" }, deepResearchOutput)
    await hook["chat.message"]?.({ sessionID: "keyword-session-mixed" }, reviewOutput)

    expect(deepResearchOutput.parts[0]?.text).toContain("DEEP RESEARCH MODE")
    expect(reviewOutput.parts[0]?.text).toContain("REVIEW MODE")
    expect(toasts).toEqual([
      {
        title: "🔬 Deep Research Mode",
        message: "Comprehensive exploration enabled. Background agents will fire.",
      },
      {
        title: "🔎 Review Mode",
        message: "Code review via Oracle activated. Critical issues will be surfaced.",
      },
    ])
  })
})
