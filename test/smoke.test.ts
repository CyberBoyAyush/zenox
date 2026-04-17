import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Model } from "@opencode-ai/sdk"
import ZenoxPlugin from "../src/index"

const createdDirs: string[] = []

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

function createProjectDir(config: object): string {
  const projectDir = mkdtempSync(join(tmpdir(), "zenox-smoke-"))
  createdDirs.push(projectDir)

  mkdirSync(join(projectDir, ".opencode"), { recursive: true })
  writeFileSync(
    join(projectDir, ".opencode", "zenox.json"),
    JSON.stringify(config, null, 2),
  )

  return projectDir
}

function createClientStub(toasts: Array<{ title: string; message: string }>) {
  return {
    tui: {
      showToast: async ({ body }: { body: { title: string; message: string } }) => {
        toasts.push({ title: body.title, message: body.message })
        return true
      },
    },
  }
}

function createModel(modelID = "claude-sonnet-4-7"): Model {
  return {
    id: `anthropic/${modelID}`,
    providerID: "anthropic",
    api: {
      id: "chat",
      url: "https://api.anthropic.com/v1/messages",
      npm: "@ai-sdk/anthropic",
    },
    name: modelID,
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: true,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
    },
    cost: {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: {
      context: 200000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
  }
}

describe("zenox smoke", () => {
  test("registers tools, injects config, and applies message hooks", async () => {
    const toasts: Array<{ title: string; message: string }> = []
    const projectDir = createProjectDir({
      agents: {
        explorer: { variant: "high" },
      },
      disabled_mcps: ["exa"],
    })

    const plugin = await ZenoxPlugin({
      client: createClientStub(toasts),
      directory: projectDir,
      worktree: projectDir,
      project: { id: "test-project" },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    expect(plugin.tool).toBeDefined()
    expect(plugin.tool?.background_task).toBeDefined()
    expect(plugin.tool?.background_output).toBeDefined()
    expect(plugin.tool?.session_list).toBeDefined()
    expect(plugin.tool?.find_symbols).toBeDefined()

    const config: {
      agent?: Record<string, unknown>
      mcp?: Record<string, unknown>
    } = {}
    await plugin.config?.(config as never)

    expect(config.agent?.explorer).toBeDefined()
    expect(config.agent?.librarian).toBeDefined()
    expect(config.mcp?.exa).toBeUndefined()
    expect(config.mcp?.grep_app).toBeDefined()

    const systemModel = createModel()

    const chatOutput = {
      parts: [{ type: "text", text: "please do ultrawork research" }],
      message: {
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-7",
        },
      },
    }

    await plugin["chat.message"]?.(
      {
        sessionID: "session-1",
        agent: "explorer",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-7" },
      },
      chatOutput,
    )

    expect(chatOutput.message).toEqual({
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-7",
        variant: "high",
      },
    })
    expect(chatOutput.parts[0]?.text).toContain("ULTRAWORK MODE ACTIVE")
    expect(toasts.at(-1)?.title).toBe("⚡ Ultrawork Mode")

    const buildChatOutput = {
      parts: [{ type: "text", text: "build this feature" }],
      message: {
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-7",
        },
      },
    }

    await plugin["chat.message"]?.(
      {
        sessionID: "session-2",
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-7" },
      },
      buildChatOutput,
    )

    const systemOutput = { system: [] as string[] }
    await plugin["experimental.chat.system.transform"]?.(
      { sessionID: "session-2", model: systemModel },
      systemOutput,
    )

    expect(systemOutput.system).toHaveLength(1)
    expect(systemOutput.system[0]).toContain("## Sub-Agent Delegation")
  })

  test("does not inject orchestration for non-build agents", async () => {
    const projectDir = createProjectDir({})
    const plugin = await ZenoxPlugin({
      client: createClientStub([]),
      directory: projectDir,
      worktree: projectDir,
      project: { id: "test-project" },
      serverUrl: new URL("http://localhost:4096"),
      $: {} as never,
    } as never)

    await plugin["chat.message"]?.(
      {
        sessionID: "session-3",
        agent: "oracle",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-7" },
      },
      {
        parts: [{ type: "text", text: "inspect this" }],
        message: {
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-7",
          },
        },
      },
    )

    const systemOutput = { system: [] as string[] }
    await plugin["experimental.chat.system.transform"]?.(
      { sessionID: "session-3", model: createModel() },
      systemOutput,
    )

    expect(systemOutput.system).toHaveLength(0)
  })
})
