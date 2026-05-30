import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { syncBundledSkills } from "../src/skills"

const createdDirs: string[] = []

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/** Build a fake bundled skills dir with one skill. */
function makeBundled(skillBody = "v1 body"): string {
  const dir = mkdtempSync(join(tmpdir(), "zenox-bundled-"))
  createdDirs.push(dir)
  const skillDir = join(dir, "demo-skill")
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: demo-skill\ndescription: demo\n---\n${skillBody}`)
  writeFileSync(join(skillDir, "LICENSE.txt"), "MIT")
  return dir
}

function makeTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), "zenox-target-"))
  createdDirs.push(dir)
  return dir
}

describe("syncBundledSkills", () => {
  test("fresh install copies files and writes a manifest", () => {
    const bundled = makeBundled()
    const target = makeTarget()

    const result = syncBundledSkills({
      packageVersion: "1.0.0",
      bundledSkillsDir: bundled,
      targetSkillsDir: target,
    })

    expect(result.installed).toContain("demo-skill")
    expect(existsSync(join(target, "demo-skill", "SKILL.md"))).toBe(true)
    expect(existsSync(join(target, "demo-skill", "LICENSE.txt"))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(target, "demo-skill", ".zenox.json"), "utf-8"))
    expect(manifest.managedBy).toBe("zenox")
    expect(manifest.packageVersion).toBe("1.0.0")
    expect(Object.keys(manifest.files)).toContain("SKILL.md")
  })

  test("is idempotent for the same version (skips)", () => {
    const bundled = makeBundled()
    const target = makeTarget()
    syncBundledSkills({ packageVersion: "1.0.0", bundledSkillsDir: bundled, targetSkillsDir: target })

    const second = syncBundledSkills({ packageVersion: "1.0.0", bundledSkillsDir: bundled, targetSkillsDir: target })
    expect(second.installed).toHaveLength(0)
    expect(second.skipped).toContain("demo-skill")
  })

  test("updates an unmodified skill when the version changes", () => {
    const target = makeTarget()
    syncBundledSkills({ packageVersion: "1.0.0", bundledSkillsDir: makeBundled("v1 body"), targetSkillsDir: target })

    const newBundled = makeBundled("v2 body")
    const result = syncBundledSkills({ packageVersion: "2.0.0", bundledSkillsDir: newBundled, targetSkillsDir: target })

    expect(result.updated).toContain("demo-skill")
    expect(readFileSync(join(target, "demo-skill", "SKILL.md"), "utf-8")).toContain("v2 body")
  })

  test("does NOT overwrite a user-edited skill", () => {
    const target = makeTarget()
    syncBundledSkills({ packageVersion: "1.0.0", bundledSkillsDir: makeBundled("v1 body"), targetSkillsDir: target })

    // Simulate a user edit
    const installedSkill = join(target, "demo-skill", "SKILL.md")
    writeFileSync(installedSkill, "user customized content")

    const result = syncBundledSkills({ packageVersion: "2.0.0", bundledSkillsDir: makeBundled("v2 body"), targetSkillsDir: target })

    expect(result.skipped).toContain("demo-skill")
    expect(readFileSync(installedSkill, "utf-8")).toBe("user customized content")
  })

  test("respects disabled_skills", () => {
    const bundled = makeBundled()
    const target = makeTarget()

    const result = syncBundledSkills({
      packageVersion: "1.0.0",
      bundledSkillsDir: bundled,
      targetSkillsDir: target,
      disabledSkills: ["demo-skill"],
    })

    expect(result.skipped).toContain("demo-skill")
    expect(existsSync(join(target, "demo-skill"))).toBe(false)
  })

  test("NEVER overrides a user's own same-named skill (no Zenox manifest)", () => {
    const bundled = makeBundled("zenox bundled body")
    const target = makeTarget()
    // User already has their OWN skill named "demo-skill" (no .zenox.json).
    const userSkill = join(target, "demo-skill")
    mkdirSync(userSkill, { recursive: true })
    writeFileSync(join(userSkill, "SKILL.md"), "USER OWNED — do not touch")

    const result = syncBundledSkills({
      packageVersion: "1.0.0",
      bundledSkillsDir: bundled,
      targetSkillsDir: target,
    })

    expect(result.skipped).toContain("demo-skill")
    expect(result.installed).not.toContain("demo-skill")
    expect(result.updated).not.toContain("demo-skill")
    // User content is fully preserved and NOT adopted (no manifest written).
    expect(readFileSync(join(userSkill, "SKILL.md"), "utf-8")).toBe("USER OWNED — do not touch")
    expect(existsSync(join(userSkill, ".zenox.json"))).toBe(false)
  })

  test("preserves user-ADDED files inside a Zenox-managed skill on update", () => {
    const target = makeTarget()
    // Install v1.0.0 (creates a manifest).
    syncBundledSkills({ packageVersion: "1.0.0", bundledSkillsDir: makeBundled("v1 body"), targetSkillsDir: target })

    // User drops their own extra file into the managed folder (manifest files untouched).
    const installed = join(target, "demo-skill")
    writeFileSync(join(installed, "my-notes.md"), "MY PERSONAL NOTES")

    // A new version ships.
    const result = syncBundledSkills({ packageVersion: "2.0.0", bundledSkillsDir: makeBundled("v2 body"), targetSkillsDir: target })

    // The folder has an unexpected user file -> treated as modified -> skipped.
    expect(result.skipped).toContain("demo-skill")
    expect(result.updated).not.toContain("demo-skill")
    expect(existsSync(join(installed, "my-notes.md"))).toBe(true)
    expect(readFileSync(join(installed, "my-notes.md"), "utf-8")).toBe("MY PERSONAL NOTES")
  })

  test("does not even adopt a user skill whose content happens to match bundled", () => {
    const bundled = makeBundled("identical body")
    const target = makeTarget()
    const userSkill = join(target, "demo-skill")
    mkdirSync(userSkill, { recursive: true })
    // Byte-identical to bundled, but still user-created (no manifest).
    writeFileSync(
      join(userSkill, "SKILL.md"),
      "---\nname: demo-skill\ndescription: demo\n---\nidentical body"
    )
    writeFileSync(join(userSkill, "LICENSE.txt"), "MIT")

    const result = syncBundledSkills({
      packageVersion: "1.0.0",
      bundledSkillsDir: bundled,
      targetSkillsDir: target,
    })

    expect(result.skipped).toContain("demo-skill")
    // Zenox does NOT claim it — no manifest is written into a user-created folder.
    expect(existsSync(join(userSkill, ".zenox.json"))).toBe(false)
  })

  test("does not touch unrelated user skills", () => {
    const bundled = makeBundled()
    const target = makeTarget()
    const other = join(target, "unrelated-skill")
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, "SKILL.md"), "my unrelated skill")

    syncBundledSkills({ packageVersion: "1.0.0", bundledSkillsDir: bundled, targetSkillsDir: target })

    // Unrelated skill is never enumerated or modified.
    expect(readFileSync(join(other, "SKILL.md"), "utf-8")).toBe("my unrelated skill")
    expect(existsSync(join(other, ".zenox.json"))).toBe(false)
  })

  test("installs nested skill files (scripts/) recursively", () => {
    const bundled = mkdtempSync(join(tmpdir(), "zenox-nested-"))
    createdDirs.push(bundled)
    const skillDir = join(bundled, "nested-skill")
    mkdirSync(join(skillDir, "scripts"), { recursive: true })
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: nested-skill\ndescription: x\n---\nbody")
    writeFileSync(join(skillDir, "scripts", "run.sh"), "echo hi")
    const target = makeTarget()

    const result = syncBundledSkills({
      packageVersion: "1.0.0",
      bundledSkillsDir: bundled,
      targetSkillsDir: target,
    })

    expect(result.installed).toContain("nested-skill")
    expect(existsSync(join(target, "nested-skill", "scripts", "run.sh"))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(target, "nested-skill", ".zenox.json"), "utf-8"))
    expect(Object.keys(manifest.files)).toContain("scripts/run.sh")
  })

  test("leaves no orphan staging dir after install", () => {
    const bundled = makeBundled()
    const target = makeTarget()
    syncBundledSkills({ packageVersion: "1.0.0", bundledSkillsDir: bundled, targetSkillsDir: target })
    const leftovers = require("node:fs")
      .readdirSync(target)
      .filter((n: string) => n.includes("zenox-tmp"))
    expect(leftovers).toHaveLength(0)
  })

  test("does not throw when bundled dir is missing", () => {
    const target = makeTarget()
    const result = syncBundledSkills({
      packageVersion: "1.0.0",
      bundledSkillsDir: join(target, "nonexistent"),
      targetSkillsDir: target,
    })
    expect(result.installed).toHaveLength(0)
  })

  test("real bundled skills (frontend-design, grill-me) install end-to-end", () => {
    const target = makeTarget()
    // Uses the actual repo skills dir resolved from this test file's location.
    const result = syncBundledSkills({ packageVersion: "test", targetSkillsDir: target })
    const all = [...result.installed, ...result.updated, ...result.skipped]
    expect(all).toContain("frontend-design")
    expect(all).toContain("grill-me")
    expect(existsSync(join(target, "frontend-design", "SKILL.md"))).toBe(true)
    expect(existsSync(join(target, "frontend-design", "LICENSE.txt"))).toBe(true)
  })
})
