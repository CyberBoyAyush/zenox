# Zenox - Project Guidelines

## Overview

Zenox is an **OpenCode V2** plugin (`Plugin.define({ id: "zenox", setup })` from `@opencode/plugin`) that provides intelligent agent orchestration with specialized subagents (explorer, librarian, oracle, ui-planner, inspector), background tasks for parallel execution, and smart delegation. Zenox 2.x is V2-only; `zenox@1.8.1` is the last V1 release.

## Tech Stack

- **Runtime**: OpenCode V2 loads `dist/index.js` (server plugin) and `dist/tui.js` (terminal plugin, `./tui` export); both build with `--target node --packages external`
- **Language**: TypeScript (strict mode)
- **Package Manager**: Bun (`bun.lock`)
- **Build**: `bun build` + `tsc --emitDeclarationOnly`
- **Dependencies**: `@opencode/plugin` (^2.3.2; requires OpenCode >= 2.3), `zod`, `commander`, `picocolors`, `@clack/prompts`, `strip-json-comments`
- **Dev-only**: `solid-js`, `@opentui/*`, `@opencode/theme` (type peers of `@opencode/plugin/tui`), `@opencode/sdk` (embedded engine for the e2e suite)

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
├── features/             # task-toast, version-toast, todo-continuation
├── hooks/                # keyword-detector (prompt hook)
├── mcp/                  # MCP server definitions (V2 shape: disabled flag)
├── orchestration/        # Orchestration prompt for build/plan
├── shared/               # toast RPC channel, addZodTool, withTimeout
├── skills/               # Bundled skill loader (in-memory registration)
└── tools/                # project-guidelines, session-search (session_search / session_read)
```

## Commands

```bash
bun run build        # Build the plugin
bun run clean        # Remove dist folder
bun run typecheck    # Type check src + tests (tsconfig.test.json)
bun test             # Unit tests (test/*.test.ts, in-memory fake context)
bun run test:e2e     # Zenox inside the real OpenCode engine (test/e2e, fake Anthropic API, no network)
bun run check        # Everything CI runs, incl. e2e against the built dist/
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
| explorer | Codebase search, file discovery | claude-haiku-5-5 |
| librarian | Library research, docs lookup | claude-sonnet-5-5 |
| oracle | Architecture decisions, debugging | gpt-6.1-sol |
| ui-planner | Frontend design, CSS, animations | claude-opus-5-5 |
| inspector | Runs checks, reports PASS/FAIL ground truth | claude-sonnet-5-5 |

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
- `ctx.session.hook("prompt")` — keyword modes (a real user prompt also resets todo continuation); `ctx.session.hook("context")` — orchestration prompt for `build`/`plan`
- `ctx.session.hook("experimental.idle")` — runs just before any session goes idle: notifies the parent when a Zenox background child finishes (fire-and-forget) and runs todo continuation. Registration is wrapped in try/catch so Zenox still loads without it
- Background completion has three idempotent paths: the idle hook, `ctx.session.wait` on the child, and `ctx.event.subscribe({ types: ["session.idle", "session.deleted"] })` (the idle hook skips failed/interrupted runs, so the fallbacks stay). `session.deleted` detaches a parent; the stream reconnects and is aborted by the cleanup returned from `setup`
- Notices (background + todo continuation) go through `ctx.session.synthetic` with a `description` and `metadata: { source: "zenox", kind }`, never `session.prompt`, so they never look like user messages
- On OpenCode 2.3 every child session (including Zenox background children) also gets OpenCode's own `<subagent>` result message in the parent; it arrives together with Zenox's notice and the parent runs one turn (covered by the e2e suite)
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
BackgroundTask has a `claiming` flag (src/background/types.ts) alongside `notified`. getCompletionStatusForSession() claims a batch synchronously (sets claiming=true) the moment it computes an all-complete notification, excluding it from any other concurrent caller. The caller must confirm via manager.markNotified(tasks) after a successful delivery, or manager.releaseClaim(tasks) after a failed one — never both, never neither. hasActiveBackgroundWork() is purely state-based: true if any task for a session is "running" or "claiming" (no time-based grace window). deliverNotification (src/plugin.ts) races the actual session.synthetic() delivery against a 30s bound (src/shared/with-timeout.ts's withTimeout) so a hung call can't wedge the claim forever, and a failed all-complete batch is retried on the parent's next idle and on a bounded timer (3 attempts, 15s backoff) since events may not arrive.

## SDK Version
Zenox 2.1 targets `@opencode/plugin` ^2.3.2 (Promise API, `Plugin.define`) and declares `engines.opencode >= 2.3.0`. Background child sessions use `ctx.session.create({ parentID, agent, model?, permissions, metadata })`; completion notices use `ctx.session.synthetic({ resume })` (resume=false for partial, true for all-complete). anomalyco/opencode#44788 (synthetic/context/events not reaching plugins) was fixed in 2.2.0 and the e2e suite proves synthetic notices reach the model. Agents are never silently swapped: if a subagent is rejected the launch fails. Still not available to V2 plugins: LSP tools, agent temperature. On 2.3 the core `subagent` tool always runs in the background and reports with a `<subagent>` message.

## Background task failure notifications
When a background task fails to START (host.prompt rejects), no session.idle event fires, so the manager pushes a scoped completion notification via a registered CompletionNotifier callback (BackgroundManager.setCompletionNotifier, wired in src/plugin.ts to deliverNotification). This ensures the parent agent learns of launch failures in-conversation, not just via a toast. The partial-completion message names the task that JUST finished (passed explicitly / by latest completedAt), never relying on Map insertion order. trimRetainedTasks never evicts finished tasks whose parent session still has running tasks (so the eventual "all complete" summary is never missing tasks).

<!-- Added: 2026-10-19, updated 2026-11-19 for OpenCode 2.3 -->
## Orchestration: Subagent First
The orchestration prompt (src/orchestration/prompt.ts) and keyword contexts (src/hooks/keyword-detector/contexts.ts) make the `subagent` tool the default for almost all delegation. OpenCode 2.3 removed its foreground mode and `background` flag: each subagent runs in its own visible child session and reports back with a `<subagent>` message, so the prompt never says "foreground". Independent questions are batched as several `subagent` calls in one message; dependent ones wait for the previous report. `background_task` is reserved for extensive, long-running research (large-codebase mapping, in-depth multi-library research, the `deep research` keyword).

## Per-Task Model Override (decided 2026-11-11)
Agents always run on their default model (built-in or zenox.json). There is NO allowlist or extra config. The orchestrator passes `model` ("provider/model" or "provider/model#variant") on `subagent` / `background_task` ONLY when the user explicitly asks for a specific model for that task, and only for that one call; the orchestration prompt's "Choosing a Model (Only When the User Asks)" section says so. `background_task` validates the override with `createModelValidator` (src/host/v2.ts) against `ctx.model.list` using the same rules as the core subagent tool (exists, chat model, valid variant); blank = unset; an unreachable catalog lets session.create decide. The override is shown in the launch result, toast, background_list and completion notice ("explorer on provider/model").

## Todo Continuation
src/features/todo-continuation reads the current list from the latest completed `todowrite` tool call in `session.context` (the opt-in core todo tool keeps no server state). From the `experimental.idle` hook it injects a synthetic `[TODO CONTINUATION]` reminder when todos are pending/in_progress. Guards: main sessions only (no parentID, not a Zenox background child), skips while the session's own subagent/image/codemode jobs or Zenox background tasks run (shells don't block), never when the last assistant text ends with "?", stops after MAX_STALLS (2) continuations with an unchanged list and after `todo_continuation.max_continuations` (default 10). A real user prompt resets the budget. Config: `"todo_continuation": { "enabled", "max_continuations" }`.

## Testing and CI
- Unit tests use the in-memory fake context (test/fake-context.ts); keep it in step with any new `ctx` API Zenox calls.
- test/e2e/harness.ts boots the real engine with `@opencode/sdk` (in-memory DB, isolated HOME/XDG dirs, zenox.json disabling MCPs and pointing oracle at Anthropic), answers model calls with a scripted fake Anthropic API, and fails any other network request. Zenox tools are reached through Code Mode (`execute`), `subagent`/`todowrite` are direct tools. `ZENOX_E2E_TARGET=dist` runs the same suite against the built bundle.
- Since OpenCode 2.2.7, `agent.list` returns only the agents loaded so far while plugins load: poll until Zenox's agents appear.
- After dependency bumps, if the engine logs "models.dev models failed to parse" or drizzle query errors, delete node_modules and reinstall (stale nested `effect` copies).
- `.github/workflows/ci.yml` runs on Instabox (`runs-on: instabox-medium`, needs the instabox GitHub App on the repo): typecheck, unit, build, e2e (src + dist), Node import smoke test, package-contents check. `.github/workflows/release.yml` (GitHub-hosted, environment `npm`) stages a release with `npm stage publish` via trusted publishing when a push to main changes package.json `version`, then creates the `vX.Y.Z` GitHub release; it goes live after `npm stage approve`.
