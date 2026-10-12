import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { explorerAgent, librarianAgent, oracleAgent, uiPlannerAgent, resolveAgentModel } from "../src/agents"
import { loadPluginConfig } from "../src/config"
import type { ZenoxToast } from "../src/shared"
import { ORCHESTRATION_PROMPT, getOrchestrationPrompt } from "../src/orchestration/prompt"
import { ZenoxConfigSchema } from "../src/config"
import { createKeywordDetectorHook, KEYWORD_CONFIGS } from "../src/hooks"

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe("model resolution", () => {
  test("built-in variant is kept, overrides replace model and/or variant", () => {
    expect(resolveAgentModel("openai/gpt-5.6-sol#medium", undefined)).toBe("openai/gpt-5.6-sol#medium")
    expect(resolveAgentModel("openai/gpt-5.6-sol#medium", { variant: "xhigh" })).toBe("openai/gpt-5.6-sol#xhigh")
    expect(resolveAgentModel("openai/gpt-5.6-sol#medium", { model: "anthropic/claude-opus-4-8" })).toBe(
      "anthropic/claude-opus-4-8"
    )
    expect(resolveAgentModel("a/b", { model: "c/d#low" })).toBe("c/d#low")
    expect(resolveAgentModel("a/b", { model: "c/d#low", variant: "high" })).toBe("c/d#high")
  })
})

describe("prompt regressions", () => {
  test("oracle defaults to gpt-5.6-sol medium", () => {
    expect(oracleAgent.model).toBe("openai/gpt-5.6-sol#medium")
  })

  test("oracle prompt distinguishes grounded analysis from review mode", () => {
    expect(oracleAgent.system).toContain("keep plausible causes open")
    expect(oracleAgent.system).toContain("review format below overrides")
    expect(oracleAgent.system).toContain("Do not file a finding solely because context is missing")
    expect(oracleAgent.system).not.toContain("Dense and useful beats long and thorough")
  })

  test("orchestration prompt uses V2 tool names", () => {
    expect(ORCHESTRATION_PROMPT).toContain("`subagent` tool")
    expect(ORCHESTRATION_PROMPT).toContain('subagent(\n  agent: "explorer"')
    expect(ORCHESTRATION_PROMPT).not.toContain("subagent_type")
    expect(ORCHESTRATION_PROMPT).not.toMatch(/(^|[^_])task\(/)
    expect(ORCHESTRATION_PROMPT).not.toContain("TodoWrite")
  })

  test("explorer prompt only references available search tools", () => {
    expect(explorerAgent.system).toContain("grep_app_searchGitHub")
    expect(explorerAgent.system).not.toContain("ast_grep_search")
    expect(explorerAgent.system).not.toContain("3+ tools simultaneously")
    expect(explorerAgent.system).not.toContain("Intent Check (Required")
    expect(explorerAgent.system).toContain("Never invent a file")
    expect(explorerAgent.system).toContain("Disclose capped coverage")
    expect(explorerAgent.system).toContain("Generated code")
  })

  test("librarian prompt avoids hard minimum call quotas", () => {
    expect(librarianAgent.system).toContain("PARALLEL EXECUTION GUIDANCE")
    expect(librarianAgent.system).not.toContain("Minimum Parallel Calls")
    expect(librarianAgent.system).not.toContain("Execute ALL in parallel (6+ calls)")
  })

  test("prompts document background tools and never mention tools dropped on V2", () => {
    expect(ORCHESTRATION_PROMPT).toContain("background_task")
    expect(ORCHESTRATION_PROMPT).toContain("background_output")
    const all = [ORCHESTRATION_PROMPT, ...[explorerAgent, librarianAgent, oracleAgent, uiPlannerAgent].map((a) => a.system)]
    for (const text of all) {
      for (const dropped of ["session_list", "session_search", "find_symbols", "lsp_status"]) {
        expect(text).not.toContain(dropped)
      }
    }
  })

  test("orchestration prompt documents skills and background concurrency limits", () => {
    expect(ORCHESTRATION_PROMPT).toContain("## Skills")
    expect(ORCHESTRATION_PROMPT).toContain("frontend-design")
    expect(ORCHESTRATION_PROMPT).toContain('skill({ name: "grill-me" })')
    expect(ORCHESTRATION_PROMPT).toContain("before asking the first question")
    expect(ORCHESTRATION_PROMPT).toContain("ordinary factual questions")
    expect(ORCHESTRATION_PROMPT).toContain("Concurrency Limits")
  })

  test("ui-planner can load skills and references frontend-design", () => {
    expect(uiPlannerAgent.permissions.some((p) => p.action === "skill")).toBe(false)
    expect(uiPlannerAgent.system).toContain("frontend-design")
    // Inline skill body should be gone (now loaded via the skill tool)
    expect(uiPlannerAgent.system).not.toContain("## NEVER Use Generic AI Aesthetics")
    expect(uiPlannerAgent.model).toBe("anthropic/claude-opus-4-8")
    expect(uiPlannerAgent.system).toContain("override the skill's greenfield aesthetic guidance")
    expect(uiPlannerAgent.system).toContain("reduced motion")
    expect(uiPlannerAgent.system).toContain("materially benefits from a package")
    expect(uiPlannerAgent.description).not.toContain("Code may be a bit messy")
  })

  test("orchestration prompt omits a disabled-agents note when none are disabled", () => {
    const prompt = getOrchestrationPrompt("build", new Set())
    expect(prompt).toBeDefined()
    expect(prompt).not.toContain("## Disabled Agents")
    // Static content is preserved unchanged.
    expect(prompt).toContain("## Sub-Agent Delegation")
  })

  test("orchestration prompt warns about disabled agents (PR #5 premise)", () => {
    const prompt = getOrchestrationPrompt("build", new Set(["ui-planner", "oracle"]))
    expect(prompt).toContain("## Disabled Agents")
    expect(prompt).toContain("`ui-planner`")
    expect(prompt).toContain("`oracle`")
    expect(prompt).toContain("Do not delegate to them")
  })

  test("orchestration prompt warns about disabled skills", () => {
    const prompt = getOrchestrationPrompt("build", new Set(), new Set(["grill-me"]))
    expect(prompt).toContain("## Disabled Skills")
    expect(prompt).toContain("`grill-me`")
    expect(prompt).toContain("overrides the generic capability examples")
    expect(prompt).toContain("Do not load or recommend")
  })

  test("getOrchestrationPrompt returns undefined for non build/plan agents", () => {
    expect(getOrchestrationPrompt("explorer", new Set(["oracle"]))).toBeUndefined()
    expect(getOrchestrationPrompt(undefined)).toBeUndefined()
  })
})

describe("V2 capability audit", () => {
  const agents = [explorerAgent, librarianAgent, oracleAgent, uiPlannerAgent]
  const texts = () => [
    getOrchestrationPrompt("build")!,
    ...agents.map((a) => a.system),
    ...KEYWORD_CONFIGS.map((k) => k.context),
  ]

  test("no prompt advertises a feature that does not exist on OpenCode V2", () => {
    const unavailable = [
      "session_list", "session_search", "find_symbols", "lsp_status", "todowrite", "TodoWrite",
      "Todo Continuation", "subagent_type", "Code Intelligence", "Session History", "bash(",
    ]
    for (const text of texts()) {
      for (const name of unavailable) expect(text).not.toContain(name)
      expect(text).not.toMatch(/(^|[^_])task\(/)
    }
  })

  test("orchestration prompt steers background work to background_task", () => {
    expect(getOrchestrationPrompt("build")).toContain("not the `subagent` tool's own `background` flag")
  })

  test("librarian defaults to Claude Sonnet 5.5", () => {
    expect(librarianAgent.model).toBe("anthropic/claude-sonnet-5-5")
  })
})

describe("config schema additions", () => {
  test("auto_update.show_startup_toast is accepted (PR #4)", () => {
    const parsed = ZenoxConfigSchema.safeParse({ auto_update: { show_startup_toast: false } })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.auto_update?.show_startup_toast).toBe(false)
    }
  })

  test("background limits are accepted", () => {
    const parsed = ZenoxConfigSchema.safeParse({ background: { max_concurrent: 4, max_per_session: 20 } })
    expect(parsed.success).toBe(true)
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

describe("keyword detector", () => {
  function hook() {
    const toasts: Array<Pick<ZenoxToast, "title" | "message">> = []
    const detect = createKeywordDetectorHook((t) => toasts.push({ title: t.title, message: t.message }))
    const run = (sessionID: string, text: string) => {
      const event = { sessionID, prompt: { text } }
      detect(event)
      return event.prompt.text
    }
    return { toasts, run }
  }

  test("injects a keyword context once per session and keyword set", () => {
    const { toasts, run } = hook()
    expect(run("keyword-session", "please do deep research")).toContain("DEEP RESEARCH MODE")
    expect(run("keyword-session", "please do deep research")).toBe("please do deep research")
    expect(toasts).toEqual([
      {
        title: "🔬 Deep Research Mode",
        message: "Comprehensive exploration enabled. Background agents will fire.",
      },
    ])
  })

  test("re-injects keyword context for a different session", () => {
    const { toasts, run } = hook()
    expect(run("a", "please do deep research")).toContain("DEEP RESEARCH MODE")
    expect(run("b", "please do deep research")).toContain("DEEP RESEARCH MODE")
    expect(toasts).toHaveLength(2)
  })

  test("injects different keyword contexts within the same session", () => {
    const { toasts, run } = hook()
    expect(run("mixed", "please do deep research")).toContain("DEEP RESEARCH MODE")
    expect(run("mixed", "please review this implementation")).toContain("REVIEW MODE")
    expect(toasts.map((t) => t.title)).toEqual(["🔬 Deep Research Mode", "🔎 Review Mode"])
  })

  test("blueprint keyword injects the plan-lock pipeline", () => {
    const { toasts, run } = hook()
    const text = run("bp", "let's blueprint this feature before writing code")
    expect(text).toContain("BLUEPRINT MODE")
    expect(text).toContain("Done when:")
    expect(toasts.at(-1)?.title).toBe("📐 Blueprint Mode")
  })

  test("keyword contexts use V2 tool names", () => {
    const { run } = hook()
    const review = run("r", "code review please")
    expect(review).toContain('subagent(\n  agent: "oracle"')
    expect(review).not.toContain("subagent_type")
    expect(review).not.toContain("bash(")
  })
})
