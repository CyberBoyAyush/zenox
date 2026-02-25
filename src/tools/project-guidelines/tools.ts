/**
 * Project Guidelines Tools
 *
 * Intelligent auto-update of AGENTS.md and CLAUDE.md with important decisions,
 * patterns, and conventions. Reads existing content first, deduplicates,
 * adds date stamps, and only writes genuinely new information.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

export type ProjectGuidelinesTools = {
  [key: string]: ToolDefinition
}

const GUIDELINE_FILES = ["AGENTS.md", "CLAUDE.md"] as const

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "have", "been", "some", "them",
  "than", "its", "over", "such", "that", "this", "with", "will", "each",
  "from", "they", "any", "use", "used", "using", "into", "when", "what",
  "where", "which", "should", "would", "could", "does", "also", "just",
  "more", "about", "like", "make", "only", "very", "after", "before",
  "other", "most", "then", "these", "those", "being", "here", "there",
])

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Extract meaningful keywords from text for comparison.
 * Filters out stop words, short tokens, and markdown syntax.
 */
function extractKeywords(text: string): Set<string> {
  const cleaned = text
    .toLowerCase()
    .replace(/<!--.*?-->/gs, "")      // strip HTML comments
    .replace(/```[\s\S]*?```/g, "")   // strip code blocks
    .replace(/`[^`]+`/g, "")          // strip inline code
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // markdown links → text
    .replace(/#{1,6}\s*/g, "")        // strip heading markers
    .replace(/[^a-z0-9\s-]/g, " ")   // non-alphanum → space
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .filter((w) => !STOP_WORDS.has(w))

  return new Set(cleaned)
}

/**
 * Split markdown content into logical sections by headings.
 * Returns an array of section strings.
 */
function splitIntoSections(content: string): string[] {
  const sections = content.split(/(?=^#{1,3}\s)/m)
  return sections.filter((s) => s.trim().length > 0)
}

/**
 * Check if new content is a duplicate of anything already in the file.
 * Uses keyword overlap — if 65%+ of the new content's keywords appear
 * in any existing section, it's considered a duplicate.
 */
function findDuplicateSection(
  newContent: string,
  existingContent: string
): { isDuplicate: boolean; matchedSection: string | null; overlapRatio: number } {
  const newKeywords = extractKeywords(newContent)
  if (newKeywords.size < 2) {
    return { isDuplicate: false, matchedSection: null, overlapRatio: 0 }
  }

  const sections = splitIntoSections(existingContent)
  let bestOverlap = 0
  let bestSection: string | null = null

  for (const section of sections) {
    const sectionKeywords = extractKeywords(section)
    let overlap = 0

    for (const keyword of newKeywords) {
      if (sectionKeywords.has(keyword)) overlap++
    }

    const ratio = overlap / newKeywords.size
    if (ratio > bestOverlap) {
      bestOverlap = ratio
      bestSection = section.trim().split("\n")[0] ?? section.trim().substring(0, 80)
    }
  }

  return {
    isDuplicate: bestOverlap >= 0.65,
    matchedSection: bestSection,
    overlapRatio: bestOverlap,
  }
}

/**
 * Find the most relevant existing section to place new content under.
 * If a section shares 30-64% keyword overlap, the new content belongs there.
 */
function findRelatedSection(
  newContent: string,
  existingContent: string
): { sectionHeader: string | null; overlapRatio: number } {
  const newKeywords = extractKeywords(newContent)
  if (newKeywords.size < 2) {
    return { sectionHeader: null, overlapRatio: 0 }
  }

  const sections = splitIntoSections(existingContent)
  let bestOverlap = 0
  let bestHeader: string | null = null

  for (const section of sections) {
    const sectionKeywords = extractKeywords(section)
    let overlap = 0

    for (const keyword of newKeywords) {
      if (sectionKeywords.has(keyword)) overlap++
    }

    const ratio = overlap / newKeywords.size
    if (ratio > bestOverlap && ratio >= 0.3) {
      bestOverlap = ratio
      const headerMatch = section.match(/^(#{1,3}\s.+)$/m)
      bestHeader = headerMatch ? headerMatch[1] : null
    }
  }

  return { sectionHeader: bestHeader, overlapRatio: bestOverlap }
}

/**
 * Format content with a date comment for tracking when guidelines were added.
 */
function formatWithDate(content: string): string {
  const date = new Date().toISOString().split("T")[0]
  return `\n<!-- Added: ${date} -->\n${content}`
}

/**
 * Intelligently write content into a guideline file.
 * If a related section exists, append under it. Otherwise append at end.
 */
async function smartWrite(
  filePath: string,
  content: string,
  existingContent: string | null
): Promise<{ action: "created" | "appended" | "merged"; detail: string }> {
  const formattedContent = formatWithDate(content)

  if (!existingContent) {
    await fs.writeFile(filePath, formattedContent.trimStart() + "\n")
    return { action: "created", detail: "Created new file" }
  }

  // Try to find a related section to merge under
  const related = findRelatedSection(content, existingContent)

  if (related.sectionHeader) {
    // Insert after the related section's last line
    const sectionIndex = existingContent.indexOf(related.sectionHeader)
    if (sectionIndex !== -1) {
      // Find end of this section (next heading or end of file)
      const afterHeader = existingContent.substring(
        sectionIndex + related.sectionHeader.length
      )
      const nextHeadingMatch = afterHeader.match(/\n(?=#{1,3}\s)/)
      const insertPoint = nextHeadingMatch
        ? sectionIndex + related.sectionHeader.length + (nextHeadingMatch.index ?? 0)
        : existingContent.length

      const before = existingContent.substring(0, insertPoint)
      const after = existingContent.substring(insertPoint)
      const separator = before.endsWith("\n") ? "" : "\n"
      await fs.writeFile(filePath, before + separator + formattedContent + "\n" + after)

      return {
        action: "merged",
        detail: `Merged under existing section: ${related.sectionHeader.trim()}`,
      }
    }
  }

  // No related section found — append at end
  const separator = existingContent.endsWith("\n") ? "" : "\n"
  await fs.writeFile(filePath, existingContent + separator + formattedContent + "\n")
  return { action: "appended", detail: "Appended as new section" }
}

export function createProjectGuidelinesTools(
  projectDir: string
): ProjectGuidelinesTools {
  const saveProjectGuideline = tool({
    description: `Save important project decisions, patterns, or conventions to AGENTS.md and CLAUDE.md.

This tool is INTELLIGENT — it:
- Reads existing file content first to check for duplicates
- Skips writing if the information is already documented (65%+ keyword overlap)
- Adds date stamps to track when guidelines were added
- Merges under related existing sections when possible
- Only appends as a new section if the content is genuinely new

Use this to document REAL, LASTING decisions:
- Technology choices (frameworks, libraries, tools)
- Architecture decisions (patterns, conventions, file structure)
- Agreed-upon conventions (naming, coding style, project rules)
- Reusable patterns or utilities worth remembering

Do NOT use for:
- One-off decisions, temporary workarounds, or experiments
- Things obvious from the code itself
- Content that hasn't been decided yet (save after the decision, not during exploration)

Write content as a clear, complete statement. Example:
"## State Management\\nUse Zustand over Redux. Stores live in src/stores/ with one store per domain."`,
    args: {
      content: tool.schema
        .string()
        .describe(
          "The guideline, decision, or pattern to document. Write as a clear, complete, searchable statement."
        ),
    },
    async execute(args) {
      try {
        const content = args.content.trim()
        if (!content) {
          return "Error: Content cannot be empty"
        }

        // Minimal content guard — reject overly short/vague content
        const contentWords = content.split(/\s+/).filter((w) => w.length >= 2)
        if (contentWords.length < 3) {
          return "Skipped: Content is too short or vague to be a meaningful guideline. Write a clear, complete statement."
        }

        // Read existing files
        const fileContents: Record<string, string | null> = {}
        const existingFileNames: string[] = []

        for (const fileName of GUIDELINE_FILES) {
          const filePath = path.join(projectDir, fileName)
          if (await fileExists(filePath)) {
            fileContents[fileName] = await fs.readFile(filePath, "utf-8")
            existingFileNames.push(fileName)
          } else {
            fileContents[fileName] = null
          }
        }

        // Check for duplicates across ALL existing files
        for (const fileName of existingFileNames) {
          const existing = fileContents[fileName]
          if (!existing) continue

          const dupCheck = findDuplicateSection(content, existing)
          if (dupCheck.isDuplicate) {
            return `Skipped: This guideline is already documented in ${fileName} (${Math.round(dupCheck.overlapRatio * 100)}% overlap with section: "${dupCheck.matchedSection}"). No changes made.`
          }
        }

        const results: string[] = []

        if (existingFileNames.length === 0) {
          // No files exist — create AGENTS.md
          const agentsPath = path.join(projectDir, "AGENTS.md")
          const writeResult = await smartWrite(agentsPath, content, null)
          results.push(`AGENTS.md: ${writeResult.action} — ${writeResult.detail}`)
        } else {
          // Write to all existing guideline files
          for (const fileName of existingFileNames) {
            const filePath = path.join(projectDir, fileName)
            const writeResult = await smartWrite(
              filePath,
              content,
              fileContents[fileName]
            )
            results.push(`${fileName}: ${writeResult.action} — ${writeResult.detail}`)
          }
        }

        const preview = content.substring(0, 100) + (content.length > 100 ? "..." : "")
        return `Saved guideline: "${preview}"\n${results.join("\n")}`
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error"
        return `Failed to save guideline: ${errorMsg}`
      }
    },
  })

  return {
    save_project_guideline: saveProjectGuideline,
  }
}
