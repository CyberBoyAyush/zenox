# Zenox - Project Guidelines

## Overview

Zenox is an OpenCode plugin that provides intelligent agent orchestration with specialized subagents (explorer, librarian, oracle, ui-planner, inspector), background tasks for parallel execution, and smart delegation.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode)
- **Package Manager**: Bun (`bun.lock`)
- **Build**: `bun build` + `tsc --emitDeclarationOnly`
- **Dependencies**: `@opencode-ai/plugin`, `@opencode-ai/sdk`, `zod`, `commander`, `picocolors`, `@clack/prompts`

## Project Structure

```
src/
├── index.ts              # Plugin entry point
├── agents/               # Subagent definitions (explorer, librarian, oracle, ui-planner, inspector)
├── background/           # Background task system for parallel execution
├── cli/                  # CLI commands (install, config)
├── config/               # Configuration loading and schema
├── features/             # Feature modules (task-toast)
├── hooks/                # Event hooks (auto-update, keyword-detector, todo-enforcer)
├── mcp/                  # MCP server integrations (exa, grep_app, sequential-thinking)
├── orchestration/        # System prompt injection for delegation
├── shared/               # Shared utilities (variants, gates)
└── tools/                # Tool definitions (session, code-intelligence, project-guidelines)
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
| librarian | Library research, docs lookup | claude-sonnet-4-6 |
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

## Plugin Hooks

- `chat.message` - Variant handling, keyword detection, session tracking
- `experimental.chat.system.transform` - Injects orchestration prompts
- `event` - Handles session lifecycle, background task completion

## Important Patterns

- **Type exports only from index.ts** - Don't export functions (OpenCode treats all exports as plugins)
- **Defensive null checks** - Always handle undefined agent/model in session context
- **Graceful fallbacks** - Variants and configs should fail silently if invalid

<!-- Added: 2026-05-30 -->
## Bundled Skills
Zenox bundles skills under the package-root `skills/` directory (shipped via package.json `files`). Each skill is a folder with SKILL.md (+ LICENSE.txt). Currently bundled: frontend-design (Anthropic, Apache-2.0) and grill-me (MIT). They auto-install to ~/.config/opencode/skills/ on `zenox install` AND self-sync on plugin startup (first session.created) so they update with the package. Sync logic lives in src/skills/sync.ts: it uses a per-skill .zenox.json manifest (packageVersion + per-file sha256) to detect user edits and never clobber them. copySkill stages into a pid-unique temp dir then atomic-renames (no lock needed). Add new skills by dropping a folder in skills/ and listing it; disabled via zenox.json "disabled_skills".

## Background Task Concurrency Limits
Background tasks have hard limits enforced atomically inside BackgroundManager.launch() (src/background/manager.ts): max_concurrent (default 6, simultaneously running), max_per_session (default 50, lifetime circuit breaker per session), and taskTimeoutMs (default 30 min — a task whose child session never goes idle is aborted and marked failed, freeing its slot). launch() throws BackgroundLimitError when a limit is hit; the background_task tool returns the friendly message. A `reserved` counter makes check+reserve atomic (no TOCTOU). Configurable via zenox.json "background": { "max_concurrent", "max_per_session", "timeout_minutes" }. The plugin registers a `dispose` hook that clears all background state including pending timeout timers.

## Background Completion Notification Lifecycle (claim/release, not a timer)
BackgroundTask has a `claiming` flag (src/background/types.ts) alongside `notified`. getCompletionStatusForSession() claims a batch synchronously (sets claiming=true) the moment it computes an all-complete notification, excluding it from any other concurrent caller. The caller must confirm via manager.markNotified(tasks) after a successful delivery, or manager.releaseClaim(tasks) after a failed one — never both, never neither. hasActiveBackgroundWork() (used to suppress the todo-enforcer) is purely state-based: true if any task for a session is "running" or "claiming" — there is deliberately no time-based grace window (an earlier 60s/15s timer-based version had a real "lost edge" stall bug: the enforcer only fires on session.idle, so a synthesis turn faster than the window still suppressed its only idle event). sendCompletionNotification (src/index.ts) races the actual session.prompt() delivery against a 30s bound (src/shared/with-timeout.ts's withTimeout) so a hung call can't wedge the claim forever, and the session.idle handler retries any still-unclaimed all-complete batch on the session's next idle (scoped to allComplete only, not partial heads-ups).

## SDK Version
Zenox targets @opencode-ai/plugin and @opencode-ai/sdk 1.18.13 (bumped from 1.15.12 — verified via byte-diffing the actual shipped .d.ts files: the v1 SDK surface used by PluginInput.client, AgentConfig, and the Hooks interface is unchanged aside from one new optional hook). The `dispose` Hooks method is available and used. A separate, still-beta "v2" Effect/Promise plugin API exists under `@opencode-ai/plugin/v2/*` (opt-in via the `next` dist-tag) — not adopted; the classic default-export `Plugin` API Zenox uses remains the officially documented, stable path.

<!-- Added: 2026-05-30 -->
## Skill Preservation Rule (never clobber user skills)
Zenox skill sync (src/skills/sync.ts) ONLY manages skill folders it created itself, identified by a `.zenox.json` manifest. Hard rules: (1) skills the user installed that Zenox doesn't bundle are never enumerated or touched; (2) if a skill folder with a bundled name (frontend-design, grill-me) already exists but has NO .zenox.json manifest, Zenox skips it entirely and does NOT adopt it — even if content is byte-identical to the bundled version (no manifest is written into user-created folders); (3) if the folder has a Zenox manifest but the user edited the files (hash mismatch), it is preserved (skipped); (4) Zenox only overwrites when a manifest exists, the version changed, AND the files are unmodified. This guarantees Zenox never overrides a user's pre-existing same-named skill.

<!-- Added: 2026-05-30 -->
## Skill update preserves user-added files
isUnmodified() in src/skills/sync.ts checks BOTH that every manifest-listed file matches its hash AND that there are no EXTRA files on disk beyond the manifest. If a user added their own file into a Zenox-managed skill folder, the update is treated as "modified" and skipped (the folder is preserved), because copySkill does a destructive rm+rename. This closes a gap where user-added files would have been wiped on version updates.

## Background task failure notifications
When a background task fails to START (continueLaunch sendPrompt throws), no session.idle event fires, so the manager pushes a scoped completion notification via a registered CompletionNotifier callback (BackgroundManager.setCompletionNotifier, wired in src/index.ts to sendCompletionNotification). This ensures the parent agent learns of launch failures in-conversation, not just via a toast. The partial-completion message names the task that JUST finished (passed explicitly / by latest completedAt), never relying on Map insertion order. trimRetainedTasks never evicts finished tasks whose parent session still has running tasks (so the eventual "all complete" summary is never missing tasks).
