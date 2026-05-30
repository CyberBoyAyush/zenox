/**
 * Skill Sync
 *
 * Installs Zenox's bundled skills into the OpenCode global skills directory
 * (~/.config/opencode/skills/<name>/) and keeps them in sync with the running
 * package version. Used by both the CLI installer and the plugin runtime so
 * skills auto-update whenever Zenox itself updates.
 *
 * Safety:
 * - A per-skill manifest (.zenox.json) records the package version + file hashes.
 * - Zenox only overwrites files it manages and that the user has NOT edited.
 * - All failures are non-fatal (read-only FS, partial writes, etc.).
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  statSync,
  rmSync,
  renameSync,
} from "node:fs"
import { join, dirname, relative, sep } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

const MANIFEST_FILE = ".zenox.json"

/** Files inside a skill folder that are never treated as skill content. */
const IGNORED_ENTRIES = new Set([MANIFEST_FILE])

export interface SkillSyncResult {
  installed: string[]
  updated: string[]
  skipped: string[]
}

interface SkillManifest {
  managedBy: "zenox"
  packageVersion: string
  files: Record<string, string>
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex")
}

/**
 * Resolve the OpenCode global skills directory.
 * Mirrors the XDG logic used elsewhere in the codebase.
 */
export function getGlobalSkillsDir(): string {
  if (process.platform === "win32") {
    const crossPlatform = join(homedir(), ".config", "opencode")
    if (existsSync(crossPlatform)) return join(crossPlatform, "skills")
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming")
    return join(appData, "opencode", "skills")
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(xdg, "opencode", "skills")
}

/**
 * Locate the bundled `skills/` directory at runtime.
 * Walks up from this module's location looking for a `skills/` folder that
 * contains at least one SKILL.md. Works whether running from src (tests),
 * dist/index.js (plugin), or dist/cli/index.js (CLI).
 */
export function findBundledSkillsDir(startUrl: string = import.meta.url): string | null {
  let dir: string
  try {
    dir = dirname(fileURLToPath(startUrl))
  } catch {
    return null
  }

  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "skills")
    // Validate: the skills dir must sit beside a zenox package.json so we never
    // accidentally match an unrelated ancestor `skills/` directory.
    if (
      existsSync(candidate) &&
      containsAnySkill(candidate) &&
      isZenoxPackageDir(dir)
    ) {
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
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

/**
 * Read the Zenox package version by walking up from the bundled location to the
 * nearest package.json named "zenox". Falls back to "0.0.0" if not found.
 */
export function readPackageVersion(startUrl: string = import.meta.url): string {
  let dir: string
  try {
    dir = dirname(fileURLToPath(startUrl))
  } catch {
    return "0.0.0"
  }
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, "package.json")
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string; version?: string }
        if (pkg.name === "zenox" && pkg.version) return pkg.version
      } catch {
        /* ignore and keep walking up */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return "0.0.0"
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

/**
 * Recursively list skill files as POSIX-style relative paths (so nested
 * resources like scripts/ or assets/ are included). The manifest file is
 * always excluded.
 */
function listSkillFiles(skillDir: string, base: string = skillDir): string[] {
  const out: string[] = []
  let entries: import("node:fs").Dirent[]
  try {
    entries = readdirSync(skillDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(skillDir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listSkillFiles(full, base))
    } else if (entry.isFile()) {
      const rel = relative(base, full).split(sep).join("/")
      if (!IGNORED_ENTRIES.has(rel)) out.push(rel)
    }
  }
  return out
}

function readManifest(skillDir: string): SkillManifest | null {
  try {
    const raw = readFileSync(join(skillDir, MANIFEST_FILE), "utf-8")
    const parsed = JSON.parse(raw) as SkillManifest
    if (parsed?.managedBy === "zenox" && parsed.files) return parsed
  } catch {
    /* missing or corrupt manifest -> treat as unmanaged */
  }
  return null
}

/**
 * True if the installed skill folder exactly matches the manifest:
 * - every manifest-listed file exists and hashes match, AND
 * - there are NO extra files on disk that the manifest doesn't know about.
 *
 * The extra-file check matters because an update does a destructive
 * rm+rename; if the user dropped their own files into a Zenox-managed folder,
 * we must treat that as "modified" and preserve it rather than wipe it.
 */
function isUnmodified(installedDir: string, manifest: SkillManifest): boolean {
  const manifestKeys = Object.keys(manifest.files)

  for (const [file, hash] of Object.entries(manifest.files)) {
    const path = join(installedDir, file)
    if (!existsSync(path)) return false
    if (sha256(readFileSync(path)) !== hash) return false
  }

  // Detect user-added files not tracked by the manifest.
  const onDisk = listSkillFiles(installedDir)
  if (onDisk.length !== manifestKeys.length) return false
  const known = new Set(manifestKeys)
  for (const file of onDisk) {
    if (!known.has(file)) return false
  }

  return true
}

/**
 * Install a skill atomically: stage all files (plus manifest) into a sibling,
 * pid-unique temp dir, then swap it into place with an atomic rename.
 *
 * No lock is needed: when the plugin and CLI run concurrently they copy the
 * exact same bundled content + version stamp, so any winner produces an
 * identical, complete result. The rename is atomic (same parent filesystem),
 * so the target is never left half-written. A crash mid-copy leaves only an
 * orphan .tmp dir, cleaned up here on the error path and on the next run.
 */
function copySkill(bundledDir: string, targetDir: string, files: string[], version: string): void {
  const stagingDir = `${targetDir}.zenox-tmp-${process.pid}-${Date.now()}`
  try {
    mkdirSync(stagingDir, { recursive: true })
    const manifestFiles: Record<string, string> = {}
    for (const rel of files) {
      const content = readFileSync(join(bundledDir, rel))
      const dest = join(stagingDir, rel)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, content)
      manifestFiles[rel] = sha256(content)
    }
    const manifest: SkillManifest = {
      managedBy: "zenox",
      packageVersion: version,
      files: manifestFiles,
    }
    writeFileSync(join(stagingDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n")

    // Swap into place: remove the old target, then rename staging -> target.
    rmSync(targetDir, { recursive: true, force: true })
    renameSync(stagingDir, targetDir)
  } finally {
    // Clean up staging dir if the swap never happened (error path).
    if (existsSync(stagingDir)) {
      rmSync(stagingDir, { recursive: true, force: true })
    }
  }
}

export interface SyncOptions {
  /** Current Zenox package version (stamped into the manifest). */
  packageVersion: string
  /** Skill names the user disabled; these are not installed. */
  disabledSkills?: string[]
  /** Override the bundled source dir (mainly for tests). */
  bundledSkillsDir?: string
  /** Override the target dir (mainly for tests). */
  targetSkillsDir?: string
}

/**
 * Install/update bundled skills. Idempotent and safe to call on every startup.
 * Never throws — returns a summary of what changed.
 */
export function syncBundledSkills(options: SyncOptions): SkillSyncResult {
  const result: SkillSyncResult = { installed: [], updated: [], skipped: [] }
  const disabled = new Set(options.disabledSkills ?? [])

  const bundledDir = options.bundledSkillsDir ?? findBundledSkillsDir()
  if (!bundledDir || !existsSync(bundledDir)) return result

  const targetRoot = options.targetSkillsDir ?? getGlobalSkillsDir()

  let skillNames: string[]
  try {
    skillNames = readdirSync(bundledDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(bundledDir, e.name, "SKILL.md")))
      .map((e) => e.name)
  } catch {
    return result
  }

  for (const name of skillNames) {
    if (disabled.has(name)) {
      result.skipped.push(name)
      continue
    }

    const sourceDir = join(bundledDir, name)
    const targetDir = join(targetRoot, name)
    const files = listSkillFiles(sourceDir)
    if (files.length === 0) continue

    try {
      // Fresh install.
      if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
        copySkill(sourceDir, targetDir, files, options.packageVersion)
        result.installed.push(name)
        continue
      }

      const manifest = readManifest(targetDir)

      // No Zenox manifest -> this folder was NOT created by Zenox. Never touch
      // a skill the user installed themselves, even if the name collides with
      // a bundled skill. Zenox only ever manages folders it created.
      if (!manifest) {
        result.skipped.push(name)
        continue
      }

      // Already up to date for this version.
      if (manifest.packageVersion === options.packageVersion) {
        result.skipped.push(name)
        continue
      }

      // Version changed: only overwrite if the user hasn't edited the files.
      if (isUnmodified(targetDir, manifest)) {
        copySkill(sourceDir, targetDir, files, options.packageVersion)
        result.updated.push(name)
      } else {
        result.skipped.push(name) // user-edited -> preserve
      }
    } catch {
      // Read-only FS / permission error / partial write -> skip this skill.
      result.skipped.push(name)
    }
  }

  return result
}
