import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatSkippedFilesReport,
  parseStagedPackageReport,
  resolveGitInstallSkillPackageDirs,
} from "./install.js";

// KEE-1123: the git install path must not skip a step scripts/release.sh performs.
// These cover the two defects an independent review raised on PR #63:
//   - the skills package set was hard-coded and had already drifted
//   - the "skipped files[]" report never reached the user

type FixtureEntry = {
  dir: string;
  name: string;
  files?: string[];
  dependencies?: Record<string, string>;
};

// resolveGitInstallWorkspacePackages walks @paperclipai/server's dependency
// graph, so a fixture only reaches a package by declaring the edge to it. That is
// deliberate: the git install stages the server's closure, so only packages in
// that closure can need a skills copy.
function makeCheckout(entries: FixtureEntry[]): string {
  const root = mkdtempSync(join(tmpdir(), "kee-1123-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "scripts", "release-package-manifest.json"),
    `${JSON.stringify(entries.map(({ dir, name }) => ({ dir, name })), null, 2)}\n`,
  );
  for (const entry of entries) {
    const target = join(root, entry.dir);
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, "package.json"),
      `${JSON.stringify({ name: entry.name, files: entry.files, dependencies: entry.dependencies }, null, 2)}\n`,
    );
  }
  return root;
}

describe("resolveGitInstallSkillPackageDirs", () => {
  it("returns every staged package that declares skills in files[]", () => {
    const root = makeCheckout([
      {
        dir: "server",
        name: "@paperclipai/server",
        files: ["dist", "ui-dist", "skills"],
        dependencies: {
          "@paperclipai/adapter-claude-local": "workspace:*",
          "@paperclipai/adapter-cursor-local": "workspace:*",
          "@paperclipai/adapter-gemini-local": "workspace:*",
          "@paperclipai/adapter-opencode-local": "workspace:*",
        },
      },
      { dir: "packages/adapters/claude-local", name: "@paperclipai/adapter-claude-local", files: ["dist", "skills"] },
      // cursor-local / gemini-local / opencode-local are the three that the
      // previous hard-coded list missed. server depends on all of them, which is
      // why they are in the staged closure and so why they need a skills copy.
      { dir: "packages/adapters/cursor-local", name: "@paperclipai/adapter-cursor-local", files: ["dist", "skills"] },
      { dir: "packages/adapters/gemini-local", name: "@paperclipai/adapter-gemini-local", files: ["dist", "skills"] },
      { dir: "packages/adapters/opencode-local", name: "@paperclipai/adapter-opencode-local", files: ["dist", "skills"] },
      { dir: "packages/db", name: "@paperclipai/db", files: ["dist"] },
    ]);

    expect(resolveGitInstallSkillPackageDirs(root).sort()).toEqual([
      "packages/adapters/claude-local",
      "packages/adapters/cursor-local",
      "packages/adapters/gemini-local",
      "packages/adapters/opencode-local",
      "server",
    ]);
  });

  it("picks up a package that starts declaring skills, so the list cannot drift again", () => {
    const root = makeCheckout([
      {
        dir: "server",
        name: "@paperclipai/server",
        files: ["dist", "skills"],
        dependencies: { "@paperclipai/adapter-new-local": "workspace:*" },
      },
      { dir: "packages/adapters/new-local", name: "@paperclipai/adapter-new-local", files: ["dist", "skills"] },
    ]);

    expect(resolveGitInstallSkillPackageDirs(root)).toContain("packages/adapters/new-local");
  });

  it("ignores packages with no skills entry", () => {
    const root = makeCheckout([
      { dir: "server", name: "@paperclipai/server", files: ["dist"] },
      { dir: "packages/db", name: "@paperclipai/db" },
    ]);

    expect(resolveGitInstallSkillPackageDirs(root)).toEqual([]);
  });
});

describe("parseStagedPackageReport", () => {
  it("reads the --json report prepare-bundled-package.mjs writes to stdout", () => {
    const stdout = ['some other build noise', '{"name":"@paperclipai/server","copied":["dist"],"missing":["ui-dist","skills"]}'].join("\n");

    expect(parseStagedPackageReport(stdout, undefined)).toEqual({
      packageName: "@paperclipai/server",
      missing: ["ui-dist", "skills"],
    });
  });

  it("returns no missing entries when the script reports a clean stage", () => {
    const stdout = '{"name":"@paperclipai/server","copied":["dist","ui-dist","skills"],"missing":[]}';

    expect(parseStagedPackageReport(stdout, undefined).missing).toEqual([]);
  });

  it("falls back to every declared entry when the report cannot be parsed", () => {
    // Loud, not quiet: an unreadable report must never look like a clean stage.
    expect(parseStagedPackageReport("totally unexpected output", "@paperclipai/server", ["dist", "ui-dist"]).missing)
      .toEqual(["dist", "ui-dist"]);
    expect(parseStagedPackageReport("", "@paperclipai/server", ["dist"]).missing).toEqual(["dist"]);
    expect(parseStagedPackageReport('{"name":"x","missing":"nope"}', "@paperclipai/server", ["dist"]).missing)
      .toEqual(["dist"]);
  });

  it("uses the caller's package name when the script does not report one", () => {
    expect(parseStagedPackageReport('{"missing":["skills"]}', "@paperclipai/adapter-cursor-local").packageName)
      .toBe("@paperclipai/adapter-cursor-local");
  });
});

describe("formatSkippedFilesReport", () => {
  it("reports nothing when every package staged completely", () => {
    expect(formatSkippedFilesReport([
      { packageName: "@paperclipai/server", missing: [] },
      { packageName: "@paperclipai/db", missing: [] },
    ])).toEqual([]);
  });

  it("names the package and the entries that were skipped", () => {
    const lines = formatSkippedFilesReport([
      { packageName: "@paperclipai/server", missing: [] },
      { packageName: "@paperclipai/adapter-cursor-local", missing: ["skills"] },
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("@paperclipai/adapter-cursor-local");
    expect(lines[0]).toContain("skills");
    expect(lines[0]).toContain("Warning");
  });
});
