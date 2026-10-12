import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findBundledSkillsDir, loadBundledSkills, parseSkillMarkdown, readPackageVersion } from "../src/skills"
import { installPlugin, isPluginInstalled, createDefaultConfig } from "../src/cli/config-manager"
import { saveProjectGuideline } from "../src/tools/project-guidelines"
import { buildVersionToast } from "../src/features/version-toast"

const temps: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zenox-test-"))
  temps.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("bundled skills", () => {
  test("finds the package skills and version", () => {
    expect(findBundledSkillsDir()).toEndWith("/skills")
    expect(readPackageVersion()).toMatch(/^2\.\d+\.\d+/)
  })

  test("loads frontend-design and grill-me with parsed frontmatter", () => {
    const skills = loadBundledSkills()
    expect(skills.map((s) => s.id)).toEqual(["frontend-design", "grill-me"])
    const grill = skills.find((s) => s.id === "grill-me")!
    expect(grill.name).toBe("grill-me")
    expect(grill.description).toContain("Interview the user relentlessly")
    expect(grill.content).toStartWith("Interview me relentlessly")
  })

  test("honors disabled skills and tolerates a missing directory", () => {
    expect(loadBundledSkills(["grill-me"]).map((s) => s.id)).toEqual(["frontend-design"])
    expect(loadBundledSkills([], null)).toEqual([])
    expect(loadBundledSkills([], "/definitely/missing")).toEqual([])
  })

  test("parseSkillMarkdown handles files without frontmatter", () => {
    expect(parseSkillMarkdown("just text")).toEqual({ fields: {}, body: "just text" })
    expect(parseSkillMarkdown('---\nname: "x"\n---\nbody').fields.name).toBe("x")
  })
})

describe("CLI config manager (V2 plugins key)", () => {
  test("default config uses the V2 plugins key", async () => {
    const path = join(tempDir(), "opencode.json")
    await createDefaultConfig(path)
    expect(JSON.parse(readFileSync(path, "utf-8")).plugins).toEqual(["zenox"])
  })

  test("adds zenox to an existing plugins array (json)", async () => {
    const path = join(tempDir(), "opencode.json")
    writeFileSync(path, JSON.stringify({ model: "a/b", plugins: [{ package: "other", options: {} }] }))
    await installPlugin(path)
    const config = JSON.parse(readFileSync(path, "utf-8"))
    expect(config.plugins).toEqual(["zenox", { package: "other", options: {} }])
    expect(config.model).toBe("a/b")
  })

  test("adds a plugins key to jsonc while preserving comments", async () => {
    const path = join(tempDir(), "opencode.jsonc")
    writeFileSync(path, '{\n  // keep me\n  "model": "a/b"\n}\n')
    await installPlugin(path)
    const content = readFileSync(path, "utf-8")
    expect(content).toContain("// keep me")
    expect(content).toContain('"plugins": ["zenox"]')
  })

  test("detects string, pinned and object entries under either key", () => {
    expect(isPluginInstalled({ plugins: ["zenox"] })).toBe(true)
    expect(isPluginInstalled({ plugins: ["zenox@2.0.0"] })).toBe(true)
    expect(isPluginInstalled({ plugins: [{ package: "zenox", options: {} }] })).toBe(true)
    expect(isPluginInstalled({ plugin: ["zenox"] })).toBe(true)
    expect(isPluginInstalled({ plugins: ["zenox-other"] })).toBe(false)
  })
})

describe("save_project_guideline", () => {
  test("creates AGENTS.md, then skips duplicates", async () => {
    const dir = tempDir()
    const content = "## State Management\nUse Zustand over Redux. Stores live in src/stores with one store per domain."
    expect(await saveProjectGuideline(dir, content)).toContain("AGENTS.md: created")
    expect(readFileSync(join(dir, "AGENTS.md"), "utf-8")).toContain("Use Zustand over Redux")
    expect(await saveProjectGuideline(dir, content)).toStartWith("Skipped:")
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false)
  })

  test("also updates an existing CLAUDE.md", async () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "CLAUDE.md"), "# Notes\n")
    const out = await saveProjectGuideline(dir, "Use pnpm for every package install in this repository.")
    expect(out).toContain("CLAUDE.md")
  })

  test("rejects vague content", async () => {
    expect(await saveProjectGuideline(tempDir(), "zustand")).toStartWith("Skipped:")
  })
})

describe("version toast", () => {
  test("announces upgrades and otherwise shows the running version", () => {
    expect(buildVersionToast("1.8.1", "2.0.0")).toMatchObject({
      title: "✅ zenox updated!",
      message: "v1.8.1 → v2.0.0",
    })
    expect(buildVersionToast("", "2.0.0").title).toBe("⚡ zenox v2.0.0")
    expect(buildVersionToast("2.0.0", "2.0.0").title).toBe("⚡ zenox v2.0.0")
  })
})
