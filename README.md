# ayush-opencode

Custom OpenCode plugin with specialized subagents and orchestration injection.

## Features

- **4 Custom Subagents**: Explorer, Librarian, Oracle, UI-Planner
- **Orchestration Injection**: Automatically teaches Build/Plan agents how to delegate tasks
- **Portable**: Install on any machine via opencode.json

## Installation

Just add to your `opencode.json` — OpenCode will auto-install the plugin:

```json
{
  "plugin": ["ayush-opencode@0.1.0"]
}
```

That's it! Restart OpenCode and the plugin is ready to use.

## Plugin Versioning & Updates

> **Important**: OpenCode does NOT auto-update plugins. You must pin versions for reliable updates.

### Recommended: Pin the Version

```json
{
  "plugin": ["ayush-opencode@0.1.0"]
}
```

**Why pin versions?** OpenCode uses Bun's lockfile which pins resolved versions. If you use `"ayush-opencode"` without a version, it resolves to "latest" once and **never updates** even when new versions are published.

### Upgrading to a New Version

Simply change the version in your config and restart OpenCode:

```jsonc
// Change from:
"plugin": ["ayush-opencode@0.1.0"]

// To:
"plugin": ["ayush-opencode@0.2.0"]
```

OpenCode will detect the version mismatch and install the new version automatically.

### If You're Stuck on an Old Version

If you previously used an unpinned version, clear the cache:

```bash
rm -rf ~/.cache/opencode/node_modules ~/.cache/opencode/bun.lock
```

Then restart OpenCode with a pinned version in your config.

## Agents

### @explorer
Fast codebase search specialist. Use for:
- "Where is X implemented?"
- "Find all files containing Y"
- Pattern matching and locating implementations

**Model**: `anthropic/claude-haiku-4-5`

### @librarian
Open-source research agent. Use for:
- "How does library X work?"
- "Show me implementation examples"
- Finding official documentation

**Model**: `anthropic/claude-sonnet-4-5`

### @oracle
Strategic technical advisor. Use for:
- Architecture decisions
- Code review and debugging strategy
- Technical trade-offs analysis

**Model**: `openai/gpt-5.2-high`

### @ui-planner
Designer-turned-developer. Use for:
- Beautiful UI/UX implementation
- Frontend aesthetics and animations
- Visual design without mockups

**Model**: `google/gemini-3-pro-high`

## Orchestration

This plugin automatically injects delegation guidelines into OpenCode's Build and Plan agents. After installation, these agents will know when and how to delegate tasks to the specialized subagents.

### Example Delegations

| User Request | Delegated To |
|--------------|--------------|
| "How does React Query handle caching?" | @librarian |
| "Where is the auth middleware?" | @explorer |
| "Should I use Redux or Zustand?" | @oracle |
| "Make this dashboard look better" | @ui-planner |

## Configuration (Optional)

You can customize agent models or disable agents by creating a config file.

### Config File Locations

| Location | Priority | Use Case |
|----------|----------|----------|
| `~/.config/opencode/ayush-opencode.json` | Base | User-level defaults |
| `.opencode/ayush-opencode.json` | Override | Project-specific settings |

Project config overrides user config when both exist.

### Config Options

```json
{
  "agents": {
    "explorer": { "model": "anthropic/claude-haiku-4-5" },
    "librarian": { "model": "anthropic/claude-sonnet-4-5" },
    "oracle": { "model": "openai/gpt-5.2-high" },
    "ui-planner": { "model": "google/gemini-3-pro-high" }
  },
  "disabled_agents": []
}
```

### Override Models

To use different models for specific agents:

```json
{
  "agents": {
    "explorer": { "model": "anthropic/claude-sonnet-4" },
    "oracle": { "model": "openai/gpt-4o" }
  }
}
```

### Disable Agents

To disable specific agents:

```json
{
  "disabled_agents": ["oracle", "ui-planner"]
}
```

Available agent names: `explorer`, `librarian`, `oracle`, `ui-planner`

## MCP Tools Required

This plugin assumes you have the following MCP servers configured:

- `exa` - For web search and code context
- `grep_app` - For GitHub code search
- `sequential-thinking` - For complex reasoning

Configure these in your `opencode.json`:

```json
{
  "mcp": {
    "exa": {
      "type": "local",
      "command": ["npx", "-y", "mcp-remote", "https://mcp.exa.ai/mcp?tools=web_search_exa,get_code_context_exa,crawling_exa"],
      "enabled": true
    },
    "grep_app": {
      "type": "remote",
      "url": "https://mcp.grep.app",
      "enabled": true
    },
    "sequential-thinking": {
      "type": "local",
      "command": ["npx", "@modelcontextprotocol/server-sequential-thinking"],
      "enabled": true
    }
  }
}
```

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Type check
bun run typecheck
```

## Credits & Acknowledgments

This plugin was built with inspiration and learnings from:

- **[OpenCode](https://opencode.ai)** — The CLI tool this plugin extends. Check out their [documentation](https://opencode.ai/docs) and [plugin development guide](https://opencode.ai/docs/plugins).

- **[oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode)** by [YeonGyu Kim](https://github.com/code-yeongyu) — A fantastic OpenCode plugin that pioneered many orchestration patterns used here. The agent delegation strategies, parallel execution patterns, and prompt structuring were heavily influenced by their work.

## License

MIT
