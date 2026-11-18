<p align="center">
  <img src="https://res.cloudinary.com/dyetf2h9n/image/upload/v1768073623/ZENOX_e4boob.png" alt="Zenox" width="600" />
</p>

<h1 align="center">ZENOX</h1>

<p align="center">
  <strong>Intelligent agent orchestration for OpenCode V2</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/zenox"><img src="https://img.shields.io/npm/v/zenox.svg?style=flat-square" alt="npm version" /></a>
  <a href="https://github.com/CyberBoyAyush/zenox/actions/workflows/ci.yml"><img src="https://github.com/CyberBoyAyush/zenox/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/CyberBoyAyush/zenox/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="license" /></a>
</p>

---

> **Zenox 2.1 requires OpenCode 2.3 or newer** (`@opencode/cli` 2.x, including OpenChamber 2.x). Still on OpenCode V1? Pin `"zenox@1.8.1"` in your `plugin` array.

Zenox supercharges [OpenCode](https://opencode.ai) with specialized AI agents that handle different aspects of development. Instead of one agent doing everything, you get a team of experts — each optimized for their domain.

## Features

- **5 Specialized Agents** — Explorer, Librarian, Oracle, UI Planner, Inspector
- **Verification Loop** — Inspector runs your real checks and reports PASS/FAIL ground truth, not vibes
- **Bundled Skills** — `frontend-design` & `grill-me`, registered in memory and updated with Zenox
- **Hardened Background Tasks** — Parallel agents with concurrency limits, a per-task timeout, and a `background_list` recovery tool
- **Per-Task Model Override** — Agents always use their default model, unless you ask for a specific one for a task
- **Todo Continuation** — Keeps the agent working while its todo list still has unfinished items
- **Session Search** — `session_search` / `session_read` to recall earlier sessions in the project
- **Thinking Mode Variants** — Configure thinking levels (high, xhigh, max) per agent
- **Keyword Triggers** — `ultrawork`, `deep research`, `explore codebase`, `review`, `blueprint`
- **Project Guidelines Auto-Update** — Automatically keeps AGENTS.md (and an existing CLAUDE.md) up-to-date
- **Toasts** — Background, keyword and version toasts in the OpenCode terminal UI

## Why Zenox?

Most AI coding assistants use a single model for everything. Zenox takes a different approach:

- **Explorer** finds code fast — optimized for codebase search with a lightweight model
- **Librarian** digs deep into docs — researches libraries, finds GitHub examples, citations included
- **Oracle** thinks strategically — architecture decisions, debugging, technical trade-offs
- **UI Planner** designs beautifully — CSS, animations, interfaces that don't look AI-generated
- **Inspector** proves it — actually runs your tests/build/lint and reports PASS or FAIL, so "done" means something

The main agent automatically delegates to specialists when needed. You don't have to manage them.

## Quick Start

```bash
opencode plugin add zenox
# or: bunx zenox install   (adds "zenox" to the "plugins" array and lets you pick models)
```

That's it. Restart OpenCode (`opencode service restart`) and the agents are ready.

The package also exports a terminal plugin (`zenox/tui`) that OpenCode loads automatically to show Zenox toasts.

## Agents

| Agent | What it does | Default Model |
|-------|-------------|---------------|
| **Explorer** | Codebase grep, file discovery, pattern matching | `claude-haiku-5-5` |
| **Librarian** | Library research, docs lookup, GitHub examples | `claude-sonnet-5-5` |
| **Oracle** | Architecture decisions, debugging strategy, code review | `gpt-6.1-sol` (variant medium) |
| **UI Planner** | Frontend design, CSS, animations, visual polish | `claude-opus-5-5` |
| **Inspector** | Runs tests/build/lint, reports PASS/FAIL/PARTIAL/BLOCKED ground truth | `claude-sonnet-5-5` |

All five agents are **read-only except UI Planner** (which writes/edits code) and **Inspector** (which can run shell commands to execute checks — but still cannot edit). Deny rules are declared explicitly per agent as ordered V2 permissions, since OpenCode tools are allowed by default.

### How delegation works

You don't need to call agents directly. The main agent (Build/Plan) automatically delegates:

```
You: "Where's the authentication logic?"
→ Explorer searches the codebase

You: "How does React Query handle caching?"
→ Librarian fetches official docs + real examples

You: "Should I use Redux or Zustand here?"
→ Oracle analyzes trade-offs for your codebase

You: "Make this dashboard look better"
→ UI Planner redesigns with proper aesthetics

You: "Add rate limiting to the API"
→ Build agent implements it, then delegates to Inspector with
  "Done when: bun test passes" — Inspector runs it and reports PASS/FAIL
```

## Verification Loop

Implementing something isn't the same as proving it works. Inspector closes that gap:

1. After a non-trivial change, the main agent delegates to Inspector with an explicit **`Done when:`** line — the exact check command(s) that prove the work (tests, typecheck, lint, build).
2. Inspector **runs it for real** via the shell tool — it never edits, fixes, or refactors. It only observes and reports.
3. It returns a structured verdict: **PASS**, **PARTIAL** (the check passed but doesn't cover the full Done-when), **FAIL**, or **BLOCKED** (can't even run the check — missing deps, broken env).
4. On FAIL, it also emits a **stable failure signature** — deterministic across re-runs of the same failure, excluding timestamps/paths/ports. If a fix attempt produces the *same* signature again, that's a sign of no progress, and the main agent escalates to **Oracle** instead of retrying blindly.

```
Build agent: implements a feature
  → subagent(agent: "inspector", prompt: "Done when: bun test && bun run typecheck")
  → Inspector runs both, returns:
      status: FAIL
      signature: "auth.test.ts:42:TypeError-cannot-read-token"
  → Build agent fixes the reported failure, re-verifies
  → Same signature again? → escalate to Oracle instead of retrying the same way
  → PASS → done, reported to you
```

### Running an agent on a different model

Every agent always runs on its **default model** (or the one you set in `zenox.json`). The main agent never switches models on its own.

When you want a different model for **one task**, just ask:

```
You: "Run oracle on openai/gpt-6.1-sol#high to review this diff"
→ subagent(agent: "oracle", ..., model: "openai/gpt-6.1-sol#high")
```

Only that call uses the model you named; the next call goes back to the default. Both the built-in `subagent` tool and Zenox's `background_task` take the optional `model` (`"provider/model"` or `"provider/model#variant"`). Zenox checks it against your model list first and explains what's wrong if the model or variant doesn't exist.

Inspector's tools are strictly read + shell — it cannot write or edit files, so a bad verdict can never turn into a bad fix by the same agent that would be grading itself.

## Keyword Triggers

Include these magic words in your prompt to unlock special modes:

| Keyword | What it does |
|---------|--------------|
| `ultrawork` or `ulw` | Maximum multi-agent coordination — fires parallel background agents, sets max precision |
| `deep research` | Comprehensive exploration — fires 3-4 background agents (explorer + librarian) |
| `explore codebase` | Codebase mapping — multiple explorers search in parallel |
| `review` / `self-review` / `code review` | Fires exactly one Oracle task with the actual `git diff` — surfaces critical issues, not nitpicks |
| `blueprint` | Locks a plan before any code: frame the problem, sketch the architecture, write an explicit `Done when:` line — which Inspector later verifies against |

### Examples

```
You: "ultrawork - add authentication to this app"
→ ⚡ Ultrawork Mode activated
→ Fires explorer + librarian in parallel
→ Maximum precision engaged

You: "deep research how this project handles errors"
→ 🔬 Deep Research Mode activated
→ Fires multiple explorers + librarians
→ Waits for comprehensive results before proceeding

You: "explore codebase for payment logic"
→ 🔍 Explore Mode activated
→ Multiple explorers search patterns, implementations, tests

You: "blueprint a rate limiter for the API"
→ 📐 Blueprint Mode activated
→ Frames the problem, sketches the architecture, locks a "Done when:" line
→ Only then starts implementing — Inspector verifies against that line at the end
```

You'll see a toast notification when these modes activate.

> `grill me` / "question me" / "interview me" also loads the bundled `grill-me` skill to stress-test a plan — this one is recognized by the agent from intent, not a hard-coded regex, so phrasing can vary.

## Skills

Zenox bundles [OpenCode Agent Skills](https://opencode.ai/docs/skills) — focused expert workflows the agent loads on demand via the native `skill` tool.

| Skill | What it does |
|-------|--------------|
| **frontend-design** | Anthropic's official design philosophy for distinctive, production-grade UI that avoids generic "AI slop" aesthetics. Used by UI Planner. |
| **grill-me** | Stress-tests a plan/design by interviewing you relentlessly, one decision at a time. |

### How skills are loaded — fully automatic

Zenox registers its bundled skills **in memory** when the plugin loads (OpenCode V2 `ctx.skill`). Nothing is copied into your config directory, and they always match the installed Zenox version. The agent loads one with `skill({ name: "frontend-design" })`.

### Your own skills are never touched

If you already have a skill with the same name (for example a copy installed by Zenox 1.x in `~/.config/opencode/skills/`), Zenox **leaves it alone** and does not register its own version. Delete your copy to use the bundled one.

```bash
bunx zenox skills          # List bundled skills
```

Disable bundled skills entirely in `zenox.json` (see [Configuration](#disable-agents-mcps-or-skills)).

## Background Tasks

Need comprehensive research? Fire multiple agents in parallel:

```
background_task(agent="explorer", description="Find auth code", prompt="...")
background_task(agent="librarian", description="JWT best practices", prompt="...")

// Both run simultaneously while you keep working
// You're notified when all tasks complete
```

| Tool | What it does |
|------|--------------|
| `background_task` | Launch a background agent |
| `background_output` | Retrieve a completed task's result |
| `background_cancel` | Cancel a running task (if it was the last one, you also get the "all complete" summary right away) |
| `background_list` | List this session's tasks and their status — use it if you lose track of a task ID or miss a notification |

`background_task` also takes an optional `model` for the rare case you ask for a specific model (see [Running an agent on a different model](#running-an-agent-on-a-different-model)).

**Hung tasks don't hang forever.** Each task has a wall-clock timeout (default 30 minutes, configurable via `background.timeout_minutes`) — if a background session never goes idle, it's aborted automatically and reported as failed, freeing its concurrency slot.

**Notifications are precise.** Each finished task is only ever included in one "all complete" summary — no duplicate messages if the notification path fires more than once for the same session.

Completion notices are added to the parent session as system notices, never as fake user messages (partial notices without starting a turn; the final "all complete" notice starts one). OpenCode 2.3 also reports each child's result with its own `<subagent>` message; both arrive together and wake the parent once. Background tasks run as **child sessions** of the session that launched them, with the native `subagent` tool and `background_task` denied inside them so they can't fan out recursively.

### Toast Notifications

Zenox shows toast notifications for background task events (in the OpenCode terminal UI, via the `zenox/tui` plugin):

- ⚡ **Task Launched** — Shows task description and agent
- ✅ **Task Completed** — Shows duration and remaining count
- 🎉 **All Complete** — Shows summary of all finished tasks
- ❌ **Task Failed** — Shows error message (including timeouts)

## Todo Continuation

When the agent stops while its todo list (OpenCode's todo tool) still has unfinished items, Zenox nudges it to continue with the next one. It's built to never loop:

- It only acts on main sessions, never on subagents or background tasks.
- It waits while the session's own subagents or background tasks are still running.
- It never overrides a question the agent asked you.
- It stops if the todo list stops changing, and after `max_continuations` nudges (default `10`). Your next message resets the count.

The todo tool is opt-in in OpenCode (`"experimental": { "todo": true }`). Turn continuation off in `zenox.json`:

```json
{ "todo_continuation": { "enabled": false, "max_continuations": 10 } }
```

## Session Search

| Tool | What it does |
|------|--------------|
| `session_search` | Find past sessions in this project by title and content (omit `query` for the most recent ones) |
| `session_read` | Read the conversation of one of those sessions |

## Project Guidelines Auto-Update

Zenox automatically keeps your `AGENTS.md` (and `CLAUDE.md`, if your project already has one) up-to-date with important decisions, patterns, and conventions.

### The Problem

Developers forget to update documentation. Important decisions get lost. Team members repeat the same questions. Next session, the agent has no context.

### The Solution

Zenox detects important decisions and automatically documents them:

```
You: "In this project, always use Zustand for state management"
→ Agent checks AGENTS.md — not documented yet
→ Agent saves: "- State Management: Use Zustand, not Redux"
→ Future sessions automatically know this
```

### What Gets Documented

| Trigger | Example |
|---------|---------|
| User decision | "Always use Tailwind", "We use this API pattern" |
| Architecture choice | Agent decides between approaches after analysis |
| Reusable code | Agent creates a utility worth reusing |
| Convention discovered | Agent notices consistent patterns in codebase |

### How It Works

1. Agent recognizes something important
2. Reads `AGENTS.md` / `CLAUDE.md` to check if already documented
3. If not there → calls `save_project_guideline` to add it
4. Both files get updated (or `AGENTS.md` created if neither exists)

**Zero manual work** — your project documentation stays current automatically.

## Configuration

### Custom Models

During installation, choose "Customize models" to pick your own. Or run later:

```bash
bunx zenox config
```

Config saves to `~/.config/opencode/zenox.json`:

```json
{
  "agents": {
    "explorer": { "model": "anthropic/claude-sonnet-5-5" },
    "oracle": { "model": "openai/gpt-6.1-sol" },
    "inspector": { "model": "anthropic/claude-sonnet-5-5" }
  }
}
```

### Thinking Mode Variants

Configure thinking/reasoning levels for models that support extended thinking (like Claude, GPT with reasoning, etc.):

```json
{
  "agents": {
    "oracle": { 
      "model": "anthropic/claude-opus-4-5",
      "variant": "high"
    },
    "ui-planner": { 
      "model": "openai/gpt-5.5-codex",
      "variant": "xhigh"
    }
  }
}
```

Available variants (model-dependent):
- `low` — Minimal thinking
- `medium` — Balanced thinking
- `high` — Extended thinking
- `xhigh` — Extra high thinking
- `max` — Maximum reasoning depth

Zenox registers each agent with the V2 model reference `provider/model#variant`. A `variant` without a `model` applies to the agent's default model.

<a id="disable-agents-mcps-or-skills"></a>
### Disable Agents, MCPs, or Skills

```json
{
  "disabled_agents": ["ui-planner", "inspector"],
  "disabled_mcps": ["grep_app"],
  "disabled_skills": ["frontend-design", "grill-me"]
}
```

`disabled_agents` accepts any of: `explorer`, `librarian`, `oracle`, `ui-planner`, `inspector`.

A skill listed in `disabled_skills` is not registered. Copies left on disk by Zenox 1.x are not removed — delete the folder manually if you want it gone.

### Background Task Limits

Control how many background agents can run at once (guards against runaway fan-out that burns through your usage), and how long one is allowed to run before it's considered stuck:

```json
{
  "background": {
    "max_concurrent": 6,
    "max_per_session": 50,
    "timeout_minutes": 30
  }
}
```

- `max_concurrent` — max agents running simultaneously (default `6`)
- `max_per_session` — lifetime cap per session, a circuit breaker for runaway loops (default `50`)
- `timeout_minutes` — minutes before a still-running task is aborted and marked failed (default `30`)

When the concurrency/circuit-breaker limit is hit, the next `background_task` is rejected with a message telling the agent to wait and collect results. When the timeout fires, the task itself is aborted and its slot is freed — use `background_list` to see the timed-out task if you missed the failure toast.

## Included MCP Servers

Zenox auto-loads these tools for agents to use:

| Server | Purpose |
|--------|---------|
| **exa** | Web search, docs lookup, URL crawling |
| **grep_app** | Search millions of GitHub repos instantly |
| **sequential-thinking** | Step-by-step reasoning for complex problems |

## CLI

```bash
bunx zenox install          # Add to the opencode.json "plugins" array + configure models
bunx zenox install --no-tui # Non-interactive (uses defaults)
bunx zenox config           # Reconfigure models anytime
bunx zenox mcp              # Enable/disable MCP servers
bunx zenox update           # Runs `opencode plugin update zenox`
bunx zenox skills           # List bundled skills
bunx zenox --help           # Show all commands
```

## Updates

OpenCode V2 manages plugin packages: unpinned plugins are checked for updates at startup, and `opencode plugin update zenox` (or `bunx zenox update`) updates on demand. Exact versions such as `"zenox@2.0.0"` stay pinned. After an upgrade, Zenox shows a `zenox updated vA → vB` toast; disable the startup toast with `"auto_update": { "show_startup_toast": false }`.

## Not available on OpenCode V2 (yet)

| Zenox 1.x feature | Status |
|---|---|
| `find_symbols`, `lsp_status` | Removed — OpenCode V2 has no LSP runtime yet ([anomalyco/opencode#38528](https://github.com/anomalyco/opencode/issues/38528)) |
| Per-agent `temperature` | Removed — V2 does not send agent request settings yet |
| npm update check / plugin cache clearing | Replaced by OpenCode's own plugin updates |

## Development

```bash
bun install
bun run typecheck     # src + tests
bun test              # unit tests
bun run test:e2e      # Zenox inside the real OpenCode engine (fake model API, no network)
bun run check         # everything CI runs, including the e2e suite against the built bundle
```

CI runs on every push and pull request to `main` on [Instabox](https://instabox.sh/docs/ci) machines (`.github/workflows/ci.yml`). When a push to `main` changes the `version` in `package.json` and CI passes, `.github/workflows/release.yml` stages the release on npm with trusted publishing (no token). It goes live after a maintainer approves it with 2FA (`npm stage approve <stage-id>` or on npmjs.com), and a GitHub release `vX.Y.Z` is created.

## Credits

- [OpenCode](https://opencode.ai) — The CLI this extends
- [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) — Inspiration for orchestration patterns

## License

[MIT](LICENSE)
