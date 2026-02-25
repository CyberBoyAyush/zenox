/**
 * Context strings injected when keywords are detected.
 * These provide mode-specific guidance to the agent.
 */

export const ULTRAWORK_CONTEXT = `<ultrawork-mode>
ULTRAWORK MODE ACTIVE - Maximum multi-agent coordination engaged.

**Mandatory behaviors**:
1. Fire explore + librarian in PARALLEL BACKGROUND for ANY research task
2. Use pre-delegation reasoning before EVERY delegation
3. Continue productive work while background agents run (never idle)
4. Consult oracle for architectural decisions before implementing
5. Verify ALL delegated work before marking tasks complete

**Pre-delegation reasoning** (do this before every Task/background_task):
- What type of work? (search → background, decision → sync, visual → sync)
- Can I continue working while this runs? If yes → background_task
- Do I need this answer RIGHT NOW to proceed? If no → background_task

**Parallel research pattern**:
\`\`\`
// Fire research immediately
background_task(agent="explorer", description="Find patterns", prompt="...")
background_task(agent="librarian", description="Find best practices", prompt="...")

// Continue working while they run:
// - Plan implementation approach
// - Read files you know about
// - Identify edge cases

// When notified → retrieve and synthesize
background_output(task_id="bg_xxx")
\`\`\`
</ultrawork-mode>`

export const DEEP_RESEARCH_CONTEXT = `<deep-research-mode>
DEEP RESEARCH MODE - Comprehensive exploration requested.

**Required actions**:
1. Fire at least 2-3 parallel background agents before proceeding
2. Search BOTH internal (explorer) AND external (librarian) sources
3. Explore multiple angles: implementations, tests, patterns, docs
4. DO NOT proceed until you have comprehensive context
5. Synthesize all findings before making decisions

**Research pattern**:
\`\`\`
// Fire comprehensive research
background_task(agent="explorer", description="Find implementations", prompt="...")
background_task(agent="explorer", description="Find related tests", prompt="...")
background_task(agent="librarian", description="Find official docs", prompt="...")
background_task(agent="librarian", description="Find OSS examples", prompt="...")

// Wait for ALL results before proceeding
// When notified → retrieve, synthesize, then act
\`\`\`
</deep-research-mode>`

export const EXPLORE_CONTEXT = `<explore-mode>
EXPLORE MODE - Codebase exploration active.

**Required actions**:
1. Fire multiple explorer agents in background for parallel search
2. Search for: patterns, implementations, tests, related code
3. Map out the relevant code landscape before modifying
4. Look for existing conventions and follow them

**Exploration pattern**:
\`\`\`
// Fire multiple explorers in parallel
background_task(agent="explorer", description="Find main implementation", prompt="...")
background_task(agent="explorer", description="Find related tests", prompt="...")
background_task(agent="explorer", description="Find usage examples", prompt="...")

// Continue analyzing what you know while they search
\`\`\`
</explore-mode>`

export const REVIEW_CONTEXT = `<review-mode>
REVIEW MODE — Code review and self-review active.

**Required actions**:
1. Invoke Oracle for a thorough code review of the recent implementation
2. Oracle will use its Code Review Mode: structured findings with severity levels
3. You MUST collect Oracle's review before marking the task complete
4. Address any Critical or High severity findings before delivering

**Review pattern**:
\`\`\`
// Fire Oracle for code review
Task(
  subagent_type: "oracle",
  description: "Review recent changes",
  prompt: "Review the implementation I just completed. Focus on correctness, security, regressions, and architecture fit. Files changed: [list the files you modified]."
)

// Wait for Oracle's review → address Critical/High findings → deliver
\`\`\`

**What Oracle reviews**: correctness, security, regressions, architecture fit, performance.
**Verdict categories**: Ship it / Ship with minor fixes / Needs changes / Needs rethinking.
</review-mode>`

export type KeywordType = "ultrawork" | "deep-research" | "explore" | "review"

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
]
