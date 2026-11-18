/**
 * Real OpenCode core (embedded @opencode/sdk, in-memory database) with Zenox
 * loaded as a plugin. Every model request is answered by a scripted fake
 * Anthropic API; any other network request fails closed.
 *
 * Set ZENOX_E2E_TARGET=dist to load the built bundle instead of the sources.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"

export const MAIN_MODEL = "claude-sonnet-5-5"

interface AnthropicBlock {
  type: string
  text?: string
  name?: string
  id?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

interface AnthropicMessage {
  role: "user" | "assistant"
  content: string | AnthropicBlock[]
}

export interface ModelCall {
  model: string
  kind: "title" | "chat"
  system: string
  messages: AnthropicMessage[]
  tools: string[]
  raw: string
}

export type Reply =
  | { text: string }
  | { tool: string; input: Record<string, unknown> }
  | { tools: Array<{ tool: string; input: Record<string, unknown> }> }

export type Script = (call: ModelCall) => Reply | undefined

let handler: ((request: Request) => Promise<Response>) | undefined
let installed = false
export const blocked: string[] = []

// OpenCode may capture fetch once per process, so one delegating stub stays installed.
function installNetworkGuard(): void {
  if (installed) return
  installed = true
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (!handler) throw new Error(`Network blocked (no active harness): ${request.url}`)
    return handler(request)
  }) as typeof fetch
}

const sse = (events: object[]) =>
  new Response(
    events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } }
  )

let toolCounter = 0
function anthropicResponse(reply: Reply): Response {
  const start = {
    type: "message_start",
    message: {
      id: `msg_${++toolCounter}`,
      type: "message",
      role: "assistant",
      model: "m",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  }
  if ("text" in reply) {
    return sse([
      start,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ])
  }
  const calls = "tools" in reply ? reply.tools : [reply]
  const blocks = calls.flatMap((call, index) => [
    {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: `toolu_${++toolCounter}`, name: call.tool, input: {} },
    },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } },
    { type: "content_block_stop", index },
  ])
  return sse([
    start,
    ...blocks,
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ])
}

function parseCall(raw: string): ModelCall {
  const body = JSON.parse(raw) as {
    model: string
    system?: string | Array<{ text?: string }>
    messages: AnthropicMessage[]
    tools?: Array<{ name: string }>
  }
  const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((s) => s.text ?? "").join("\n")
  return {
    model: body.model,
    kind: system.includes("You name conversations") ? "title" : "chat",
    system,
    messages: body.messages,
    tools: (body.tools ?? []).map((t) => t.name),
    raw,
  }
}

/** Text of every block in the last user message (text and tool results). */
export function lastUserText(call: ModelCall): string {
  const last = [...call.messages].reverse().find((m) => m.role === "user")
  if (!last) return ""
  if (typeof last.content === "string") return last.content
  return last.content
    .map((block) => {
      if (block.type === "text") return block.text ?? ""
      if (block.type === "tool_result") return JSON.stringify(block.content ?? "")
      return ""
    })
    .join("\n")
}

/** Names of tools the assistant already called in this conversation. */
export function calledTools(call: ModelCall): string[] {
  return call.messages.flatMap((m) =>
    m.role === "assistant" && Array.isArray(m.content)
      ? m.content.filter((b) => b.type === "tool_use").map((b) => b.name ?? "")
      : []
  )
}

export const hasText = (call: ModelCall, needle: string) => call.raw.includes(needle)

type SDK = Awaited<ReturnType<typeof import("@opencode/sdk").OpenCode.create>>

export interface Harness {
  sdk: SDK
  calls: ModelCall[]
  chats(): ModelCall[]
  location: { directory: string }
  root: string
  script: Script
  session(options?: { agent?: string; title?: string }): Promise<string>
  prompt(sessionID: string, text: string): Promise<void>
  wait(sessionID: string): Promise<void>
  context(sessionID: string): Promise<Array<Record<string, unknown>>>
  until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, label: string, timeoutMs?: number): Promise<T>
  close(): Promise<void>
}

export interface StartOptions {
  zenox?: Record<string, unknown>
  opencode?: Record<string, unknown>
}

async function loadZenox(): Promise<Plugin.Plugin> {
  const target = process.env.ZENOX_E2E_TARGET === "dist" ? "../../dist/index.js" : "../../src/index"
  return (await import(target)).default as Plugin.Plugin
}

export async function start(options: StartOptions = {}): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zenox-e2e-")))
  // Never let real credentials from the developer's shell reach the engine.
  for (const name of Object.keys(process.env)) {
    if (/(?:_API_KEY|_AUTH_TOKEN)$/u.test(name) || name.startsWith("OPENCODE_")) delete process.env[name]
  }
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    process.env[name] = join(root, name)
    await mkdir(process.env[name]!, { recursive: true })
  }
  const directory = join(root, "work")
  await mkdir(directory)
  await mkdir(join(root, "XDG_CONFIG_HOME", "opencode"), { recursive: true })
  // No MCP traffic or processes: the harness is offline.
  const zenox = {
    disabled_mcps: ["exa", "grep_app", "sequential-thinking"],
    // Oracle defaults to OpenAI; keep every agent on the fake Anthropic API.
    agents: { oracle: { model: "anthropic/claude-opus-5-5" } },
    ...options.zenox,
  }
  await writeFile(join(root, "XDG_CONFIG_HOME", "opencode", "zenox.json"), JSON.stringify(zenox))

  const calls: ModelCall[] = []
  installNetworkGuard()
  const harness = {} as Harness
  harness.script = () => undefined
  handler = async (request) => {
    if (request.url.startsWith("https://api.anthropic.com/v1/messages")) {
      const call = parseCall(await request.text())
      calls.push(call)
      if (call.kind === "title") return anthropicResponse({ text: "E2E session" })
      return anthropicResponse(harness.script(call) ?? { text: "ok" })
    }
    blocked.push(request.url)
    throw new Error(`Network blocked by Zenox E2E harness: ${request.url}`)
  }

  const previousDirectory = process.cwd()
  process.chdir(directory)
  let sdk: SDK | undefined
  const teardown = async () => {
    try {
      await sdk?.close()
    } finally {
      handler = undefined
      process.chdir(previousDirectory)
      await rm(root, { recursive: true, force: true })
    }
  }

  const location = { directory }
  try {
    const { OpenCode } = await import("@opencode/sdk")
    sdk = await OpenCode.create({
      app: { version: "2.3.2" },
      plugins: [await loadZenox()],
      config: {
        directory: join(root, "cfg"),
        project: false,
        claude: false,
        ...(options.opencode ? { content: JSON.stringify(options.opencode) } : {}),
      },
      models: { fetch: false },
      fs: { filewatcher: false },
    } as Parameters<typeof OpenCode.create>[0])
    await sdk.integration.list({ location })
    await sdk.credential.create({
      id: "e2e_key",
      integrationID: "anthropic",
      label: "E2E key",
      value: { type: "key", key: "sk-e2e-fake" },
    } as Parameters<SDK["credential"]["create"]>[0])
  } catch (err) {
    await teardown()
    throw err
  }

  const engine = sdk
  Object.assign(harness, {
    sdk: engine,
    calls,
    chats: () => calls.filter((c) => c.kind === "chat"),
    location,
    root,
    async session(opts: { agent?: string; title?: string } = {}) {
      const created = await engine.session.create({
        location,
        model: { providerID: "anthropic", id: MAIN_MODEL },
        ...(opts.agent ? { agent: opts.agent } : {}),
        ...(opts.title ? { title: opts.title } : {}),
      } as Parameters<SDK["session"]["create"]>[0])
      return created.id
    },
    async prompt(sessionID: string, text: string) {
      await engine.session.prompt({ sessionID, text } as Parameters<SDK["session"]["prompt"]>[0])
    },
    async wait(sessionID: string) {
      await engine.experimental.session.wait({ sessionID } as Parameters<SDK["experimental"]["session"]["wait"]>[0])
    },
    async context(sessionID: string) {
      return (await engine.session.context({ sessionID } as Parameters<SDK["session"]["context"]>[0])) as unknown as Array<
        Record<string, unknown>
      >
    },
    async until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, label: string, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const value = await read()
        if (value) return value
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error(`Timed out waiting for: ${label}`)
    },
    close: teardown,
  })
  return harness
}
