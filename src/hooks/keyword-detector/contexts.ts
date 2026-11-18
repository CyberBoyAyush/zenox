/**
 * Context strings injected when keywords are detected.
 * These provide mode-specific guidance to the agent.
 */

export const ULTRAWORK_CONTEXT = `<ultrawork-mode>
ULTRAWORK MODE ACTIVE - Maximum multi-agent coordination engaged.

**Mandatory behaviors**:
1. Research before implementing: explorer for the codebase, librarian for external libraries/docs
2. Use pre-delegation reasoning before EVERY delegation
3. Consult oracle for architectural decisions before implementing
4. Verify ALL delegated work before marking tasks complete

**Pre-delegation reasoning** (do this before every delegation):
- Independent questions? → several \`subagent\` calls in ONE message (parallel, each reports back)
- Depends on an earlier answer? → one \`subagent\` call, wait for its report, then the next
- Extensive research that will take a long time while you have other work to do? → only then \`background_task\`
- In doubt → \`subagent\`
- Never set a subagent's \`model\` unless the user explicitly asked for that model

**Parallel research pattern** (each in its own visible child session):
\`\`\`
subagent(agent: "explorer", description: "Find patterns", prompt: "...")
subagent(agent: "librarian", description: "Find best practices", prompt: "...")
\`\`\`

**Stay within limits**: if you do use background tasks, launch focused batches (hard cap ~6 running). If a launch is rejected, wait and collect results with background_output before firing more.
</ultrawork-mode>`

export const DEEP_RESEARCH_CONTEXT = `<deep-research-mode>
DEEP RESEARCH MODE - Comprehensive exploration requested.

**Required actions**:
1. Fire 3-5 parallel background agents before proceeding (cap ~6 running at once)
2. Search BOTH internal (explorer) AND external (librarian) sources
3. Explore multiple angles: implementations, tests, patterns, docs
4. DO NOT make decisions or write conclusions until you have comprehensive context (reading known files and outlining while you wait is fine)
5. Synthesize all findings before making decisions
6. If a launch is rejected for hitting the limit, wait and use background_output, then run another batch

**Research pattern**:
\`\`\`
// Fire comprehensive research
background_task(agent="explorer", description="Find implementations", prompt="...")
background_task(agent="explorer", description="Find related tests", prompt="...")
background_task(agent="librarian", description="Find official docs", prompt="...")
background_task(agent="librarian", description="Find OSS examples", prompt="...")

// While they run: read known files, outline the answer (no conclusions yet)
// When notified → retrieve ALL results, synthesize, then act
\`\`\`
</deep-research-mode>`

export const EXPLORE_CONTEXT = `<explore-mode>
EXPLORE MODE - Codebase exploration active.

**Required actions**:
1. Fire multiple explorer agents in parallel as \`subagent\` calls in ONE message (each reports back when done)
2. Search for: patterns, implementations, tests, related code
3. Map out the relevant code landscape before modifying
4. Look for existing conventions and follow them
5. Use \`background_task\` only if the codebase is large enough that mapping it will take a long time while you have other work to do

**Exploration pattern**:
\`\`\`
// Fire multiple explorers in parallel (same message)
subagent(agent: "explorer", description: "Find main implementation", prompt: "...")
subagent(agent: "explorer", description: "Find related tests", prompt: "...")
subagent(agent: "explorer", description: "Find usage examples", prompt: "...")
\`\`\`
</explore-mode>`

export const REVIEW_CONTEXT = `<review-mode>
REVIEW MODE — Code review and self-review active.

**Required actions**:
1. Run \`git diff\` (or \`git diff HEAD~1\`) to capture the actual changes
2. Fire exactly ONE Oracle \`subagent\` call — include the full diff output in the prompt
3. Do NOT create multiple oracle tasks (one per file, one per concern, etc.)
4. Oracle reviews the diff directly — it will NOT read files or search the codebase
5. Collect Oracle's review before marking the task complete
6. Address any Critical or High severity findings before delivering

**Review pattern**:
\`\`\`
// Step 1: Get the diff
const diff = shell("git diff HEAD~1")

// Step 2: Fire ONE oracle task with the diff included
subagent(
  agent: "oracle",
  description: "Review recent changes",
  prompt: "Review this implementation. Here is the git diff:\\n\\n\`\`\`diff\\n[actual diff output]\\n\`\`\`\\n\\nFocus on correctness, security, regressions, and architecture fit."
)

// Step 3: Wait for verdict → address Critical/High findings → deliver
\`\`\`

**Anti-patterns (DO NOT do these)**:
- Creating separate oracle tasks per file or per concern area
- Invoking oracle with just file names and no diff/code content
- Running multiple review passes or follow-up oracle calls

**Verdict categories**: Ship it / Ship with minor fixes / Needs changes / Needs rethinking.
</review-mode>`

export const BLUEPRINT_CONTEXT = `<blueprint-mode>
BLUEPRINT MODE — Staged plan-lock pipeline active. No code before the plan is locked.

**Required stages, in order:**
1. **Frame the problem** — restate the actual requirement, list edge cases and open questions
2. **Sketch the architecture** — which files/modules are touched, what approach, what's explicitly out of scope
3. **Lock a "Done when:" line** — the exact check command(s) that will prove the work is complete (test/build/lint/typecheck). This line is handed to \`inspector\` later — make it concrete and runnable, not vague
4. Only then start implementation

**Do NOT skip ahead to code** before stage 3 is written down and shared with the user (or stated explicitly in your own plan) — premature coding is exactly what this mode exists to prevent.

**Pattern:**
\`\`\`
## Problem
[restate the requirement, edge cases, open questions]

## Architecture
[files touched, approach, what's out of scope]

## Done when:
[exact command(s) — e.g. "bun test && bun run typecheck"]

// only now: begin implementation, then at the end:
subagent(
  agent: "inspector",
  description: "Verify implementation",
  prompt: "Done when: <the exact line locked above>. Run the checks and report the verdict."
)
\`\`\`
</blueprint-mode>`

export type KeywordType =
  | "ultrawork"
  | "deep-research"
  | "explore"
  | "review"
  | "blueprint"

export interface KeywordConfig {
  type: KeywordType
  pattern: RegExp
  context: string
  toast: {
    title: string
    message: string
  }
}

export const KEYWORD_CONFIGS: KeywordConfig[] = [
  {
    type: "ultrawork",
    pattern: /\b(ultrawork|ulw)\b/i,
    context: ULTRAWORK_CONTEXT,
    toast: {
      title: "⚡ Ultrawork Mode",
      message: "Maximum precision engaged. Multi-agent coordination active.",
    },
  },
  {
    type: "deep-research",
    pattern: /\b(deep\s*research|research\s*deep(ly)?)\b/i,
    context: DEEP_RESEARCH_CONTEXT,
    toast: {
      title: "🔬 Deep Research Mode",
      message: "Comprehensive exploration enabled. Background agents will fire.",
    },
  },
  {
    type: "explore",
    pattern: /\b(explore\s*(the\s*)?(codebase|code|project))\b/i,
    context: EXPLORE_CONTEXT,
    toast: {
      title: "🔍 Explore Mode",
      message: "Codebase exploration active. Multiple explorers will run.",
    },
  },
  {
    type: "review",
    pattern: /\b(self[-\s]?review|review\s*(my|the|this)?\s*(code|changes|implementation|work)|code\s*review)\b/i,
    context: REVIEW_CONTEXT,
    toast: {
      title: "🔎 Review Mode",
      message: "Code review via Oracle activated. Critical issues will be surfaced.",
    },
  },
  {
    type: "blueprint",
    pattern: /\bblueprint\b/i,
    context: BLUEPRINT_CONTEXT,
    toast: {
      title: "📐 Blueprint Mode",
      message: "Plan-lock pipeline active. Done-when line required before code.",
    },
  },
]
