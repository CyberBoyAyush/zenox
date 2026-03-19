/**
 * Orchestration prompt to inject into Build and Plan agents.
 * This teaches the primary agents how to delegate to specialized subagents using the Task tool.
 *
 * The prompt is generated dynamically based on which agents are enabled,
 * so disabled agents are never mentioned to the AI.
 */

interface AgentMeta {
  name: string
  key: string
  useFor: string
  subagentType: string
  execution: string
  executionWhy: string
  delegateTriggers: string[]
  delegateWhy: string
  priority?: string
  criticalRule?: string
  exampleCode?: string
}

const ALL_AGENTS: AgentMeta[] = [
  {
    name: "Explorer",
    key: "explorer",
    useFor: 'Codebase grep - fast pattern matching, "Where is X?"',
    subagentType: "explorer",
    execution: "`background_task`",
    executionWhy: "It's codebase grep - fire and continue",
    delegateTriggers: [
      '"Where is X?", "Find Y", locate code | `explorer` | Fast codebase search',
      "2+ modules involved, cross-cutting concerns | `explorer` | Multi-file pattern discovery",
    ],
    delegateWhy: "Fast codebase search",
    priority: "**Explorer FIRST** — Always locate code before modifying unfamiliar areas",
    exampleCode: `// Find code in codebase
Task(
  subagent_type: "explorer",
  description: "Find auth middleware",
  prompt: "Find all authentication middleware implementations in this codebase. Return file paths and explain the auth flow."
)`,
  },
  {
    name: "Librarian",
    key: "librarian",
    useFor: "External grep - docs, GitHub, OSS examples",
    subagentType: "librarian",
    execution: "`background_task`",
    executionWhy: "It's external grep - fire and continue",
    delegateTriggers: [
      'External library, "how does X library work?" | `librarian` | Searches docs, GitHub, OSS',
    ],
    delegateWhy: "Searches docs, GitHub, OSS",
    priority: "**Librarian** — When dealing with external libraries/APIs you don't fully understand",
    criticalRule: "**Fire librarian proactively** when unfamiliar libraries are involved",
    exampleCode: `// Research external library
Task(
  subagent_type: "librarian",
  description: "React Query caching docs",
  prompt: "How does React Query handle caching? Find official documentation and real-world examples with GitHub permalinks."
)`,
  },
  {
    name: "Oracle",
    key: "oracle",
    useFor: "Strategic advisor - architecture, debugging, decisions, **code review**",
    subagentType: "oracle",
    execution: "`Task` (sync)",
    executionWhy: "Need strategic answer before proceeding",
    delegateTriggers: [
      'Architecture decision, "should I use X or Y?" | `oracle` | Deep reasoning advisor',
      "After 2+ failed fix attempts | `oracle` | Debugging escalation",
      "Completed significant implementation (3+ files) | `oracle` | Self-review for bugs/security/regressions",
      'Security-sensitive code changes | `oracle` | Security review',
      'User says "review", "self-review", "check my code" | `oracle` | Code review mode',
    ],
    delegateWhy: "Deep reasoning advisor",
    priority: "**Oracle** — For complex decisions or after 2+ failed fix attempts",
    criticalRule: "**Consult oracle BEFORE major architectural decisions**, not after",
    exampleCode: `// Architecture decision
Task(
  subagent_type: "oracle",
  description: "Redux vs Zustand analysis",
  prompt: "Analyze trade-offs between Redux and Zustand for this project. Consider bundle size, learning curve, and our existing patterns."
)

// Self-review after significant implementation (include the actual diff!)
Task(
  subagent_type: "oracle",
  description: "Review auth implementation",
  prompt: "Review this implementation. Here is the git diff:\\n\\n\`\`\`diff\\n[paste actual git diff output here]\\n\`\`\`\\n\\nFocus on correctness, security, regressions, and architecture fit."
)`,
  },
  {
    name: "UI Planner",
    key: "ui-planner",
    useFor: "Designer-developer - visual design, CSS, animations",
    subagentType: "ui-planner",
    execution: "`Task` (sync)",
    executionWhy: "Implements changes, needs write access",
    delegateTriggers: [
      "Visual/styling, CSS, animations, UI/UX | `ui-planner` | Designer-developer hybrid",
    ],
    delegateWhy: "Designer-developer hybrid",
    priority: "**UI Planner** — For ANY visual/styling work (never edit CSS/UI yourself)",
    criticalRule: "**Never touch frontend visual/styling code yourself** — Always delegate to `ui-planner`",
    exampleCode: `// UI/Visual work
Task(
  subagent_type: "ui-planner",
  description: "Redesign dashboard cards",
  prompt: "Redesign the dashboard stat cards to be more visually appealing. Use modern aesthetics, subtle animations, and ensure responsive design."
)`,
  },
]

function buildOrchestrationPrompt(enabledAgents: AgentMeta[]): string {
  const agentTableRows = enabledAgents
    .map((a) => `| **${a.name}** | ${a.useFor} | \`${a.subagentType}\` |`)
    .join("\n")

  const quickRuleRows = enabledAgents
    .map((a) => `| ${a.name} | ${a.execution} | ${a.executionWhy} |`)
    .join("\n")

  const hasBackground = enabledAgents.some(
    (a) => a.execution === "`background_task`"
  )
  const mentalModel = hasBackground
    ? `\n**Mental Model**: ${enabledAgents
        .filter((a) => a.execution === "`background_task`")
        .map((a) => a.name)
        .join(" & ")} = **grep commands**. You don't wait for grep, you fire it and continue thinking.\n`
    : ""

  const delegateTriggerRows = enabledAgents
    .flatMap((a) => a.delegateTriggers)
    .map((t) => `| ${t} |`)
    .join("\n")

  const subagentTypes = enabledAgents.map((a) => `"${a.subagentType}"`).join(" | ")

  const exampleDelegations = enabledAgents
    .filter((a) => a.exampleCode)
    .map((a) => `\`\`\`\n${a.exampleCode}\n\`\`\``)
    .join("\n\n")

  const selfReviewSection = enabledAgents.some((a) => a.key === "oracle")
    ? `
### Self-Review Protocol

After completing a **significant implementation** (3+ files changed, security-sensitive code, architecture changes), invoke Oracle for self-review:

1. Briefly announce: "Running self-review via Oracle"
2. Run \`git diff\` and include the **actual diff output** in the Oracle prompt — not just file names
3. Fire exactly **ONE** Oracle task — never create multiple oracle tasks per review
4. **Collect Oracle's review before marking task complete** — do not skip this
5. Address any Critical or High severity findings before delivering
6. Mention review results to the user: "Oracle review: [verdict]"

**When to trigger self-review:**
- Changed 3+ files in a single task
- Modified auth, security, payment, or data-handling code
- Made architecture-level changes (new patterns, refactored modules)
- User explicitly asks for review

**When to skip self-review:**
- Single file edit, trivial change
- Minor changes (<50 lines changed, 1-2 files)
- Documentation-only changes
- Config file updates
- Renaming, formatting, or import reordering
`
    : ""

  const parallelSection = hasBackground
    ? `
### Parallel Execution

To run multiple agents in parallel, call multiple Task tools in the **same response message**:

\`\`\`
// CORRECT: Multiple Task calls in ONE message = parallel execution
${enabledAgents
  .filter((a) => a.execution === "`background_task`")
  .slice(0, 2)
  .map((a) => `Task(subagent_type: "${a.subagentType}", description: "Find ${a.name.toLowerCase()} code", prompt: "...")`)
  .join("\n")}
// Both run simultaneously

// WRONG: One Task per message = sequential (slow)
Message 1: Task(...) → wait for result
Message 2: Task(...) → wait for result
\`\`\`
`
    : ""

  const priorityList = enabledAgents
    .filter((a) => a.priority)
    .map((a, i) => `${i + 1}. ${a.priority}`)
    .join("\n")

  const criticalRules = enabledAgents
    .filter((a) => a.criticalRule)
    .map((a, i) => `${i + 1}. ${a.criticalRule}`)
    .join("\n")

  return `

---

## Sub-Agent Delegation

You have specialized subagents. Use the **Task tool** to delegate work proactively.

### Available Agents

| Agent | Use For | subagent_type |
|-------|---------|---------------|
${agentTableRows}

### Quick Rule: Background vs Synchronous

| Agent | Default Execution | Why |
|-------|-------------------|-----|
${quickRuleRows}
${mentalModel}
### When to Delegate (Fire Immediately)

| Trigger | subagent_type | Why |
|---------|---------------|-----|
${delegateTriggerRows}

### How to Delegate

Use the Task tool with these parameters:

\`\`\`
Task(
  subagent_type: ${subagentTypes},
  description: "Short 3-5 word task description",
  prompt: "Detailed instructions for the agent"
)
\`\`\`

**Example delegations:**

${exampleDelegations}
${selfReviewSection}${parallelSection}
### Delegation Priority

${priorityList}

### Critical Rules

${criticalRules}
4. **Verify delegated work** before marking task complete

### When to Handle Directly (Don't Delegate)

- Single file edits with known location
- Questions answerable from code already in context
- Trivial changes requiring no specialist knowledge
- Tasks you can complete faster than explaining to an agent

---

## Coding Laws

Follow these rules for every code change, even when no separate skill is loaded:

1. **Early Exit** — Handle invalid input, nulls, and edge cases at the top with guard clauses.
2. **Parse, Don't Re-Validate** — Convert external input into trusted typed state at the boundary.
3. **Atomic Predictability** — Prefer predictable functions and explicit return values over hidden mutation.
4. **Fail Fast, Fail Loud** — Stop on invalid state with a clear error instead of patching bad data downstream.
5. **Intentional Naming** — Use names that make the logic read like an English sentence.

Before finishing implementation, quickly verify:
- Did I remove unnecessary nesting with guard clauses?
- Is core logic operating on trusted state?
- Are hidden mutations avoided or made explicit?
- Will invalid states fail clearly instead of silently?
- Do names make the flow obvious without comments?

---

## Project Guidelines — Living Documentation

**IMPORTANT**: You have \`save_project_guideline\` to keep AGENTS.md and CLAUDE.md updated with real decisions and conventions. This tool is smart — it reads existing files, checks for duplicates, adds dates, and only writes genuinely new information.

### When to Save a Guideline

Only save when a **real, lasting decision** has been made:

| Save | Don't Save |
|------|------------|
| Technology choice: "Use Zustand for state" | One-off styling: "use blue for this button" |
| Architecture decision: "API routes follow /api/v1/ pattern" | Things obvious from code itself |
| Convention agreed upon: "Components use PascalCase folders" | Temporary workarounds or experiments |
| User corrects approach: "Always use server components here" | In-progress exploration (save after decision) |
| Reusable pattern created: utility hook, helper function | Trivial config changes |

### How to Use

1. **The tool reads existing files first** — it will NOT duplicate content already documented
2. Call \`save_project_guideline({ content: "..." })\` with a clear, specific statement
3. Write content as a complete, searchable statement (not fragments)
4. The tool auto-adds a date stamp for tracking

**Good content**: \`"## State Management\\nUse Zustand over Redux. Stores live in src/stores/ with one store per domain."\`
**Bad content**: \`"zustand"\` (too vague, not searchable)

### Decision Quality Gate

Before calling \`save_project_guideline\`, ask yourself:
- Would a new developer joining tomorrow benefit from knowing this? → **Save**
- Is this a permanent decision or a temporary experiment? → Only save permanent ones
- Does AGENTS.md/CLAUDE.md already cover this? → The tool checks, but think first

---

## Background Tasks (Parallel Research)

For **independent research tasks** that benefit from parallelism, use background tasks instead of sequential Task calls.

### When to Use Background Tasks

| Scenario | Use Background Tasks |
|----------|---------------------|
| User wants "comprehensive" / "thorough" / "deep" exploration | YES - fire 3-4 agents in parallel |
| Need BOTH codebase search AND external docs | YES - explore + librarian in parallel |
| Exploring multiple modules/features simultaneously | YES - separate explore for each |
| Result of Task A needed before Task B | NO - use sequential Task |
| Single focused lookup | NO - just use Task directly |

### How Background Tasks Work

1. **Fire**: Launch multiple agents with \`background_task\` - they run in parallel
2. **Continue**: Keep working while background agents search
3. **Notify**: You'll be notified when ALL background tasks complete
4. **Retrieve**: Use \`background_output\` to get each result

### Usage

\`\`\`
// Launch parallel research (all run simultaneously)
background_task(agent="explorer", description="Find auth code", prompt="Search for authentication...")
background_task(agent="explorer", description="Find db layer", prompt="Search for database/ORM...")
background_task(agent="librarian", description="Best practices", prompt="Find framework best practices...")

// Continue working on other things while they run...

// [NOTIFICATION: All background tasks complete!]

// Retrieve results
background_output(task_id="bg_abc123")
background_output(task_id="bg_def456")
background_output(task_id="bg_ghi789")
\`\`\`

### Background Tasks vs Task Tool

| Aspect | Task Tool | Background Tasks |
|--------|-----------|------------------|
| Execution | Sequential (waits for result) | Parallel (fire-and-forget) |
| Best for | Dependent tasks, immediate needs | Independent research, breadth |
| Result | Inline, immediate | Retrieved later via background_output |

### Key Insight

- **Task** = Use when you need the result immediately before proceeding
- **Background** = Use when researching multiple angles independently

**Both tools coexist - choose based on whether tasks are dependent or independent.**

### The Parallel Research Pattern

For complex tasks, fire research first, then continue working:

\`\`\`
// 1. FIRE parallel research (don't wait!)
background_task(agent="explorer", description="Find existing patterns", prompt="...")
background_task(agent="librarian", description="Find best practices", prompt="...")

// 2. CONTINUE productive work while they run:
//    - Plan your implementation approach
//    - Read files you already know about
//    - Identify edge cases and questions

// 3. When notified → RETRIEVE and synthesize
background_output(task_id="bg_xxx")
background_output(task_id="bg_yyy")
\`\`\`

**Anti-pattern**: Firing background tasks then doing nothing. Always continue productive work!

---

## Keyword Triggers (Power User)

Include these keywords in your prompt to unlock special modes:

| Keyword | Effect |
|---------|--------|
| \`ultrawork\` or \`ulw\` | Maximum multi-agent coordination - aggressive parallel research |
| \`deep research\` | Comprehensive exploration - fires 3-4 background agents |
| \`explore codebase\` | Codebase mapping - multiple explorers in parallel |
| \`review\` / \`self-review\` / \`code review\` | Activates Oracle code review mode - surfaces critical issues |

---

## Session History Tools

You have tools to learn from past work sessions:

| Tool | Use For |
|------|---------|
| \`session_list\` | List recent sessions to find relevant past work |
| \`session_search\` | Search messages across sessions for how something was done |

### When to Use Session Tools

- **Before implementing unfamiliar features** — search if done before
- **When user says "like before" or "last time"** — find that session
- **When debugging** — check if similar issues were solved previously
- **For context on ongoing projects** — understand recent work history

### Example Usage

\`\`\`
// Find how authentication was implemented before
session_search({ query: "JWT authentication" })

// List recent sessions to understand project context
session_list({ limit: 5 })

// Find past implementations of a feature
session_search({ query: "rate limiting" })
\`\`\`

---

## Code Intelligence Tools

You have tools to understand code structure via LSP:

| Tool | Use For |
|------|---------|
| \`find_symbols\` | Search for functions, classes, variables by name |
| \`lsp_status\` | Check which language servers are running |

### When to Use Code Intelligence

- **Before editing code** — find the symbol's definition location
- **When refactoring** — search for related symbols
- **To understand project structure** — search for key symbols like "auth", "user", "api"
- **To verify LSP availability** — check if code intelligence is working
- **If LSP is unavailable or errors** — stop retrying and fall back to \`grep\`, \`glob\`, and \`read\`

### Example Usage

\`\`\`
// Find all auth-related functions/classes
find_symbols({ query: "auth" })

// Find a specific function
find_symbols({ query: "handleLogin" })

// Check LSP server status
lsp_status()

// If LSP tools fail, use text/file search instead of retrying
grep({ pattern: "handleLogin" })
\`\`\`

---

## Todo Continuation

The system automatically reminds you if you go idle with incomplete tasks.

**Best Practices:**
- Keep your todo list updated with \`TodoWrite\`
- Mark tasks complete immediately when finished
- Use clear, actionable task descriptions
- The system will prompt you to continue if tasks remain incomplete

**Note:** You don't need to invoke the todo enforcer — it runs automatically when:
- You have pending or in-progress todos
- The session goes idle
- There's been sufficient time since the last reminder


`
}

export function getOrchestrationPrompt(
  agent: "build" | "plan" | string | undefined,
  disabledAgents: Set<string> = new Set()
): string | undefined {
  switch (agent) {
    case "build":
    case "plan": {
      const enabledAgents = ALL_AGENTS.filter((a) => !disabledAgents.has(a.key))
      return buildOrchestrationPrompt(enabledAgents)
    }
    default:
      return undefined
  }
}
