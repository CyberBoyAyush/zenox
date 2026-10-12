/**
 * Bundled skills
 *
 * Zenox ships skills under the package-root `skills/` directory. On OpenCode V2
 * they are registered in memory through `ctx.skill.transform` — nothing is
 * copied into the user's config directory, so user-owned skills are never touched.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export interface BundledSkill {
  /** Folder name; used as the skill ID. */
  id: string
  name: string
  description?: string
  /** Absolute path to SKILL.md so relative resources (LICENSE, scripts) resolve. */
  path: string
  /** Markdown body without frontmatter. */
  content: string
}

/** True if `dir` contains a package.json whose name is "zenox". */
function isZenoxPackageDir(dir: string): boolean {
  const pkgPath = join(dir, "package.json")
  if (!existsSync(pkgPath)) return false
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string }
    return pkg.name === "zenox"
  } catch {
    return false
  }
}

function containsAnySkill(skillsDir: string): boolean {
  try {
    return readdirSync(skillsDir, { withFileTypes: true }).some(
      (e) => e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md"))
    )
  } catch {
    return false
  }
}

/** Walks up from `startUrl` to the zenox package root. Works from src/, dist/ and dist/cli/. */
function findPackageRoot(startUrl: string): string | null {
  let dir: string
  try {
    dir = dirname(fileURLToPath(startUrl))
  } catch {
    return null
  }
  for (let i = 0; i < 6; i++) {
    if (isZenoxPackageDir(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Locate the bundled `skills/` directory beside the zenox package.json. */
export function findBundledSkillsDir(startUrl: string = import.meta.url): string | null {
  const root = findPackageRoot(startUrl)
  if (!root) return null
  const candidate = join(root, "skills")
  return existsSync(candidate) && containsAnySkill(candidate) ? candidate : null
}

/** Read the Zenox package version. Falls back to "0.0.0". */
export function readPackageVersion(startUrl: string = import.meta.url): string {
  const root = findPackageRoot(startUrl)
  if (!root) return "0.0.0"
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
      version?: string
    }
    return pkg.version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}

/** Parse simple `key: value` YAML frontmatter. Returns the fields and the body. */
export function parseSkillMarkdown(markdown: string): {
  fields: Record<string, string>
  body: string
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown)
  if (!match) return { fields: {}, body: markdown }
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "")
  }
  return { fields, body: match[2].trimStart() }
}

/** Load all bundled skills, excluding disabled ones. Never throws. */
export function loadBundledSkills(
  disabledSkills: readonly string[] = [],
  skillsDir: string | null = findBundledSkillsDir()
): BundledSkill[] {
  if (!skillsDir) return []
  const disabled = new Set(disabledSkills)
  const skills: BundledSkill[] = []
  let entries: import("node:fs").Dirent[]
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || disabled.has(entry.name)) continue
    const skillPath = join(skillsDir, entry.name, "SKILL.md")
    if (!existsSync(skillPath)) continue
    try {
      const { fields, body } = parseSkillMarkdown(readFileSync(skillPath, "utf-8"))
      skills.push({
        id: entry.name,
        name: fields.name || entry.name,
        description: fields.description,
        path: skillPath,
        content: body,
      })
    } catch {
      // Unreadable skill: skip it rather than failing plugin startup.
    }
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id))
}
