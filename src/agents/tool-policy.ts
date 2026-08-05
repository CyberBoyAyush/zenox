/**
 * An agent's `tools` record in OpenCode is **default-allow**: a tool that is
 * simply omitted stays reachable (subject only to the normal permission
 * prompt). A tool is stripped from the model's tool list ONLY when an
 * explicit deny rule matches it.
 *
 * So a "read-only" agent has to say so by name. Omitting `bash` from a
 * research agent leaves it a shell — and a shell can write files, delete
 * files, or curl arbitrary endpoints regardless of what `write`/`edit` say.
 *
 * ORDERING HAZARD: `write`, `edit`, and `patch` all collapse onto the single
 * `permission.edit` key, applied in object-key order. A `patch: false`
 * appearing after a `write: true` therefore silently DENIES editing. Any
 * agent meant to write (e.g. ui-planner) must NOT spread this object —
 * it should declare its own tools explicitly instead.
 *
 * RESIDUAL LIMITATION: this is a deny-list, not a true allowlist. It blocks
 * the known mutation paths (write/edit/patch/bash) and task recursion, but
 * any *future* tool/MCP that can mutate state (e.g. a hypothetical
 * filesystem-write MCP tool) would still reach these agents unless it is
 * added here too. There is no `"*": false` wildcard-deny available in
 * OpenCode's agent tool config today. When adding a new mutating tool
 * anywhere in this plugin, check whether it needs to be denied here as well.
 */
export const READ_ONLY_TOOLS = {
  write: false,
  edit: false,
  patch: false,
  bash: false,
  task: false,
} as const
