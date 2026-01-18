<p align="center">
  <img src="https://res.cloudinary.com/dyetf2h9n/image/upload/v1768073623/ZENOX_e4boob.png" alt="Zenox" width="600" />
</p>

<h1 align="center">ZENOX</h1>

<p align="center">
  <strong>Intelligent agent orchestration for OpenCode</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/zenox"><img src="https://img.shields.io/npm/v/zenox.svg?style=flat-square" alt="npm version" /></a>
  <a href="https://github.com/CYBERBOYAYUSH/zenox/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="license" /></a>
</p>

---

Zenox supercharges [OpenCode](https://opencode.ai) with specialized AI agents that handle different aspects of development. Instead of one agent doing everything, you get a team of experts — each optimized for their domain.

## Features

- **4 Specialized Agents** — Explorer, Librarian, Oracle, UI Planner
- **Background Tasks** — Fire multiple agents in parallel
- **Thinking Mode Variants** — Configure thinking levels (high, xhigh, max) per agent
- **Keyword Triggers** — `ultrawork`, `deep research`, `explore codebase`
- **Session History** — Query past sessions to learn from previous work
- **Code Intelligence** — Search symbols via LSP
- **Project Guidelines Auto-Update** — Automatically keeps AGENTS.md and CLAUDE.md up-to-date
- **Todo Continuation** — Auto-reminds when tasks are incomplete
- **Auto-Updates** — Toast notification when new version available

## Why Zenox?

Most AI coding assistants use a single model for everything. Zenox takes a different approach:

- **Explorer** finds code fast — optimized for codebase search with a lightweight model
- **Librarian** digs deep into docs — researches libraries, finds GitHub examples, citations included
- **Oracle** thinks strategically — architecture decisions, debugging, technical trade-offs
- **UI Planner** designs beautifully — CSS, animations, interfaces that don't look AI-generated

The main agent automatically delegates to specialists when needed. You don't have to manage them.

## Quick Start

```bash
bunx zenox install
```

That's it. Restart OpenCode and the agents are ready.

## Agents

| Agent | What it does | Default Model |
|-------|-------------|---------------|
| **Explorer** | Codebase grep, file discovery, pattern matching | `claude-haiku-4-5` |
| **Librarian** | Library research, docs lookup, GitHub examples | `claude-sonnet-4-5` |
| **Oracle** | Architecture decisions, debugging strategy, code review | `gpt-5.2` |
| **UI Planner** | Frontend design, CSS, animations, visual polish | `gemini-3-pro-high` |

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
```

## Keyword Triggers

Include these magic words in your prompt to unlock special modes:

| Keyword | What it does |
|---------|--------------|
| `ultrawork` or `ulw` | Maximum multi-agent coordination — fires parallel background agents, sets max precision |
| `deep research` | Comprehensive exploration — fires 3-4 background agents (explorer + librarian) |
| `explore codebase` | Codebase mapping — multiple explorers search in parallel |

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
```

You'll see a toast notification when these modes activate.

## Background Tasks

Need comprehensive research? Fire multiple agents in parallel:

```
background_task(agent="explorer", description="Find auth code", prompt="...")
background_task(agent="librarian", description="JWT best practices", prompt="...")

// Both run simultaneously while you keep working
// You're notified when all tasks complete
```

### Toast Notifications

Zenox shows toast notifications for background task events:

- ⚡ **Task Launched** — Shows task description and agent
- ✅ **Task Completed** — Shows duration and remaining count
- 🎉 **All Complete** — Shows summary of all finished tasks
- ❌ **Task Failed** — Shows error message

## Session History

Query past sessions to learn from previous work:

| Tool | What it does |
|------|--------------|
| `session_list` | List recent sessions to find relevant past work |
| `session_search` | Search messages across sessions for how something was done |

```
You: "How did we implement auth last time?"
→ session_search({ query: "authentication" })
→ Finds excerpts from past sessions where auth was discussed
```

## Code Intelligence

Search for symbols via LSP (Language Server Protocol):

| Tool | What it does |
|------|--------------|
| `find_symbols` | Search for functions, classes, variables by name |
| `lsp_status` | Check which language servers are running |

```
You: "Find where handleLogin is defined"
→ find_symbols({ query: "handleLogin" })
→ Returns: Function in src/auth/handlers.ts, line 42
```

## Todo Continuation

Zenox automatically reminds you to continue working when:

- You have incomplete tasks in your todo list
- The session goes idle
- There's been enough time since the last reminder (10 second cooldown)

This keeps you on track without manual intervention. The agent will be prompted to continue until all todos are complete or blocked.

## Project Guidelines Auto-Update

Zenox automatically keeps your `AGENTS.md` and `CLAUDE.md` files up-to-date with important decisions, patterns, and conventions.

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
    "explorer": { "model": "anthropic/claude-sonnet-4.5" },
    "oracle": { "model": "openai/gpt-5.2" }
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
      "model": "openai/gpt-5.2-codex",
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

Variants are applied safely — if an agent doesn't exist or the model doesn't support the variant, it gracefully falls back.

### Disable Agents or MCPs

```json
{
  "disabled_agents": ["ui-planner"],
  "disabled_mcps": ["grep_app"]
}
```

## Included MCP Servers

Zenox auto-loads these tools for agents to use:

| Server | Purpose |
|--------|---------|
| **exa** | Web search, docs lookup, URL crawling |
| **grep_app** | Search millions of GitHub repos instantly |
| **sequential-thinking** | Step-by-step reasoning for complex problems |

## CLI

```bash
bunx zenox install          # Add to opencode.json + configure models
bunx zenox install --no-tui # Non-interactive (uses defaults)
bunx zenox config           # Reconfigure models anytime
bunx zenox --help           # Show all commands
```

## Auto-Update

Zenox checks for updates on startup. When a new version drops:

1. You see a toast notification
2. Bun cache is invalidated
3. Restart to get the update

Pin a version to disable: `"zenox@1.2.1"` in your plugins array.

## Credits

- [OpenCode](https://opencode.ai) — The CLI this extends
- [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) — Inspiration for orchestration patterns

## License

[MIT](LICENSE)
