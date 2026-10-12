# Zenox - Project Guidelines

## Overview

Zenox is an **OpenCode V2** plugin (`Plugin.define({ id: "zenox", setup })` from `@opencode/plugin`) that provides intelligent agent orchestration with specialized subagents (explorer, librarian, oracle, ui-planner, inspector), background tasks for parallel execution, and smart delegation. Zenox 2.x is V2-only; `zenox@1.8.1` is the last V1 release.

## Tech Stack

- **Runtime**: OpenCode V2 loads `dist/index.js` (server plugin) and `dist/tui.js` (terminal plugin, `./tui` export); both build with `--target node --packages external`
- **Language**: TypeScript (strict mode)
- **Package Manager**: Bun (`bun.lock`)
- **Build**: `bun build` + `tsc --emitDeclarationOnly`
- **Dependencies**: `@opencode/plugin` (^2.0.27), `zod`, `commander`, `picocolors`, `@clack/prompts`, `strip-json-comments`
- **Dev-only**: `solid-js`, `@opentui/*`, `@opencode/theme` (type peers of `@opencode/plugin/tui`)

## Project Structure

```
src/
├── index.ts              # V2 plugin entry: default export Plugin.define({ id: "zenox" })
├── plugin.ts             # setupZenox(ctx): wires core onto the V2 context (ZenoxContext slice)
├── tui.ts                # Terminal plugin (./tui export): renders toasts + version toast
├── host/v2.ts            # V2 adapter: background session host, model ref parsing
├── agents/               # API-agnostic ZenoxAgentDefinition (system, permissions, model#variant)
├── background/           # BackgroundManager (host-agnostic via BackgroundSessionHost) + tools
├── cli/                  # CLI commands (install, config, mcp, update, skills)
├── config/               # zenox.json loading and Zod schema
├── features/             # task-toast, version-toast
├── hooks/                # keyword-detector (prompt hook)
├── mcp/                  # MCP server definitions (V2 shape: disabled flag)
├── orchestration/        # Orchestration prompt for build/plan
├── shared/               # toast RPC channel, addZodTool, withTimeout
├── skills/               # Bundled skill loader (in-memory registration)
└── tools/                # project-guidelines tool
```

## Commands

```bash
bun run build        # Build the plugin
bun run clean        # Remove dist folder
bun run typecheck    # Type check without emitting
```

## Code Conventions

- **No `any` types** - Always use proper typing
- **Zod for validation** - All config schemas use Zod
- **ESM only** - `"type": "module"` in package.json
- **Minimal comments** - Only document non-obvious logic
- **No hardcoded API keys** - Always use environment variables

## Agent Types

| Agent | Purpose | Default Model |
|-------|---------|---------------|
| explorer | Codebase search, file discovery | claude-haiku-4-5 |
| librarian | Library research, docs lookup | claude-sonnet-5-5 |
| oracle | Architecture decisions, debugging | gpt-5.6-sol |
| ui-planner | Frontend design, CSS, animations | claude-opus-4-8 |
| inspector | Runs checks, reports PASS/FAIL ground truth | claude-sonnet-5 |

## Configuration

User config lives at `~/.config/opencode/zenox.json`:

```json
{
  "agents": {
    "explorer": { "model": "...", "variant": "high" }
  },
  "disabled_agents": ["ui-planner"],
  "disabled_mcps": ["grep_app"]
}
```

## Plugin Wiring (V2)

- `ctx.agent.transform` — `editor.update(id)` creates/updates the five subagents; Zenox permission rules are appended after existing rules (last match wins)
- `ctx.mcp.transform` / `ctx.skill.transform` / `ctx.tool.transform` — MCPs, in-memory bundled skills (skipped if a same-named skill exists), tools
- `ctx.session.hook("prompt")` — keyword modes; `ctx.session.hook("context")` — orchestration prompt for `build`/`plan`
- Background completion is detected with `ctx.session.wait` on the child (plus `ctx.event.subscribe` `session.idle` as a redundant, idempotent path — plugin event delivery is unreliable per anomalyco/opencode#44788); `session.deleted` detaches a parent; the stream reconnects and is aborted by the cleanup returned from `setup`
- Toasts: server emits on the `zenox` RPC event channel (`ctx.rpc.register`); `src/tui.ts` shows them

## Important Patterns

- **Only type exports besides the default from index.ts** - the plugin definition is the default export
- **Core stays API-agnostic** - only `src/plugin.ts`, `src/host/`, `src/tui.ts` and tool registration touch `@opencode/plugin`
- **Tools advertise JSON Schema** - register through `addZodTool` (Zod validation, `z.toJSONSchema` for the model)
- **Never write V2-only keys into the user's opencode.json beyond `plugins`** - agents/MCPs/skills are runtime transforms
- **Graceful fallbacks** - configs, skills and toasts fail silently if invalid or unavailable

<!-- Added: 2026-05-30 -->
## Bundled Skills
Zenox bundles skills under the package-root `skills/` directory (shipped via package.json `files`): frontend-design (Anthropic, Apache-2.0) and grill-me (MIT). On V2 they are registered in memory via `ctx.skill.transform` (src/skills/bundled.ts parses SKILL.md frontmatter; `path` points at the bundled SKILL.md). Nothing is copied to disk. A skill whose ID already exists (user-installed or a Zenox 1.x disk copy) is never overridden. Disabled via zenox.json "disabled_skills".

## Background Task Concurrency Limits
Background tasks have hard limits enforced atomically inside BackgroundManager.launch() (src/background/manager.ts): max_concurrent (default 6, simultaneously running), max_per_session (default 50, lifetime circuit breaker per session), and taskTimeoutMs (default 30 min — a task whose child session never goes idle is aborted and marked failed, freeing its slot). launch() throws BackgroundLimitError when a limit is hit; the background_task tool returns the friendly message. A `reserved` counter makes check+reserve atomic (no TOCTOU). Configurable via zenox.json "background": { "max_concurrent", "max_per_session", "timeout_minutes" }. The plugin registers a `dispose` hook that clears all background state including pending timeout timers.

## Background Completion Notification Lifecycle (claim/release, not a timer)
BackgroundTask has a `claiming` flag (src/background/types.ts) alongside `notified`. getCompletionStatusForSession() claims a batch synchronously (sets claiming=true) the moment it computes an all-complete notification, excluding it from any other concurrent caller. The caller must confirm via manager.markNotified(tasks) after a successful delivery, or manager.releaseClaim(tasks) after a failed one — never both, never neither. hasActiveBackgroundWork() is purely state-based: true if any task for a session is "running" or "claiming" (no time-based grace window). deliverNotification (src/plugin.ts) races the actual session.prompt() delivery against a 30s bound (src/shared/with-timeout.ts's withTimeout) so a hung call can't wedge the claim forever, and a failed all-complete batch is retried on the parent's next idle and on a bounded timer (3 attempts, 15s backoff) since events may not arrive.

## SDK Version
Zenox 2.x targets the OpenCode V2 plugin API `@opencode/plugin` ^2.0.27 (Promise API, `Plugin.define`). Background child sessions use `ctx.session.create({ parentID, agent, permissions, metadata })`; completion notices use `ctx.session.prompt({ resume })` (resume=false for partial, true for all-complete) — not `synthetic`, which plugins cannot reliably get into the model prompt. Agents are never silently swapped: if a subagent is rejected the launch fails. Not available on V2 (so dropped): LSP tools, session listing/search, todo continuation (V2 has no todo tool), agent temperature.

## Background task failure notifications
When a background task fails to START (host.prompt rejects), no session.idle event fires, so the manager pushes a scoped completion notification via a registered CompletionNotifier callback (BackgroundManager.setCompletionNotifier, wired in src/plugin.ts to deliverNotification). This ensures the parent agent learns of launch failures in-conversation, not just via a toast. The partial-completion message names the task that JUST finished (passed explicitly / by latest completedAt), never relying on Map insertion order. trimRetainedTasks never evicts finished tasks whose parent session still has running tasks (so the eventual "all complete" summary is never missing tasks).
