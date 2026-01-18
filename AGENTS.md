# Zenox - Project Guidelines

## Overview

Zenox is an OpenCode plugin that provides intelligent agent orchestration with specialized subagents (explorer, librarian, oracle, ui-planner), background tasks for parallel execution, and smart delegation.

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
├── agents/               # Subagent definitions (explorer, librarian, oracle, ui-planner)
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
| librarian | Library research, docs lookup | claude-sonnet-4-5 |
| oracle | Architecture decisions, debugging | gpt-5.2 |
| ui-planner | Frontend design, CSS, animations | gemini-3-pro-high |

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
