/**
 * Project Guidelines Tools
 *
 * Auto-update AGENTS.md and CLAUDE.md with important decisions,
 * patterns, and conventions discovered during development.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

export type ProjectGuidelinesTools = {
  [key: string]: ToolDefinition
}

const GUIDELINE_FILES = ["AGENTS.md", "CLAUDE.md"] as const

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function appendToFile(filePath: string, content: string): Promise<void> {
  const exists = await fileExists(filePath)
  
  if (exists) {
    const existing = await fs.readFile(filePath, "utf-8")
    const separator = existing.endsWith("\n") ? "" : "\n"
    await fs.writeFile(filePath, existing + separator + content + "\n")
  } else {
    await fs.writeFile(filePath, content + "\n")
  }
}

export function createProjectGuidelinesTools(
  projectDir: string
): ProjectGuidelinesTools {
  const saveProjectGuideline = tool({
    description: `Save important project decisions, patterns, or conventions to AGENTS.md and CLAUDE.md.
Use this to document:
- Important decisions (technology choices, architecture decisions)
- Reusable code patterns or utilities you created
- Conventions discovered or agreed upon
- Guidelines that should persist across sessions

IMPORTANT: Before calling this tool, read AGENTS.md and CLAUDE.md first to check if the information already exists. Only call this tool if the guideline is NOT already documented.

The tool appends to both files if they exist, or creates AGENTS.md if neither exists.`,
    args: {
      content: tool.schema
        .string()
        .describe("The guideline, decision, or pattern to document"),
    },
    async execute(args) {
      try {
        const content = args.content.trim()
        if (!content) {
          return "Error: Content cannot be empty"
        }

        const updatedFiles: string[] = []
        let createdFile = false

        // Check which guideline files exist
        const existingFiles: string[] = []
        for (const fileName of GUIDELINE_FILES) {
          const filePath = path.join(projectDir, fileName)
          if (await fileExists(filePath)) {
            existingFiles.push(fileName)
          }
        }

        // If no guideline files exist, create AGENTS.md
        if (existingFiles.length === 0) {
          const agentsPath = path.join(projectDir, "AGENTS.md")
          await appendToFile(agentsPath, content)
          updatedFiles.push("AGENTS.md")
          createdFile = true
        } else {
          // Append to all existing guideline files
          for (const fileName of existingFiles) {
            const filePath = path.join(projectDir, fileName)
            await appendToFile(filePath, content)
            updatedFiles.push(fileName)
          }
        }

        const fileList = updatedFiles.join(" and ")
        const action = createdFile ? "Created" : "Updated"
        return `${action} ${fileList} with: "${content.substring(0, 100)}${content.length > 100 ? "..." : ""}"`
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
