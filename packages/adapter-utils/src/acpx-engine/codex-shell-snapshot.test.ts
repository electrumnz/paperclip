import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyShellSnapshotPolicy,
  CodexShellSnapshotPolicyError,
  enforceCodexShellSnapshotPolicy,
} from "./codex-shell-snapshot.js";

const cleanupRoots: string[] = [];

// Codex reads this file at startup. A rewrite that produces invalid TOML — a
// duplicate `[features]` table, a duplicate key, a root key stranded after a
// table header — breaks every Codex run, so parse the result, don't just grep it.
function parsedFeatures(text: string): Record<string, unknown> {
  const parsed = parseToml(text) as { features?: Record<string, unknown> };
  return parsed.features ?? {};
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createCodexHome(configToml?: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kee216-codex-"));
  cleanupRoots.push(root);
  const home = path.join(root, "codex-home");
  await fs.mkdir(home, { recursive: true, mode: 0o755 });
  if (configToml !== undefined) {
    await fs.writeFile(path.join(home, "config.toml"), configToml, "utf8");
  }
  return home;
}

async function readConfig(home: string): Promise<string> {
  return await fs.readFile(path.join(home, "config.toml"), "utf8");
}

function hasGroupOrOtherAccess(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

describe("applyShellSnapshotPolicy", () => {
  it("appends the managed table to a config with no features table", () => {
    const input = 'model = "gpt-5.6-sol"\n\n[projects."/"]\ntrust_level = "trusted"\n';

    const result = applyShellSnapshotPolicy(input);

    expect(result.changed).toBe(true);
    expect(result.unsupported).toBeUndefined();
    // Root keys and the operator's tables survive; the managed table goes last,
    // because a TOML table header captures every root key that follows it.
    expect(result.text).toContain('model = "gpt-5.6-sol"');
    expect(result.text).toContain('[projects."/"]');
    expect(result.text.trimEnd().endsWith("# <<< paperclip codex runtime policy <<<")).toBe(true);
    expect(parseToml(result.text)).toMatchObject({
      model: "gpt-5.6-sol",
      features: { shell_snapshot: false },
    });
  });

  it("writes the key into an existing features table instead of declaring it twice", () => {
    const input = 'model = "gpt-5.6-sol"\n\n[features]\nweb_search = true\n\n[tui]\nnotify = true\n';

    const result = applyShellSnapshotPolicy(input);

    expect(result.changed).toBe(true);
    expect(result.text.match(/^\[features\]$/gm)).toHaveLength(1);
    expect(parsedFeatures(result.text)).toEqual({ shell_snapshot: false, web_search: true });
    expect(parseToml(result.text)).toMatchObject({ tui: { notify: true } });
  });

  it("overrides an operator value of true and keeps only one assignment", () => {
    const input = "[features]\nshell_snapshot = true\nweb_search = true\n";

    const result = applyShellSnapshotPolicy(input);

    expect(result.text.match(/shell_snapshot\s*=/g)).toHaveLength(1);
    expect(parsedFeatures(result.text)).toEqual({ shell_snapshot: false, web_search: true });
  });

  it("does not touch a shell_snapshot key that belongs to another table", () => {
    const input = "[features]\nweb_search = true\n\n[other]\nshell_snapshot = true\n";

    const result = applyShellSnapshotPolicy(input);

    expect(parsedFeatures(result.text)).toEqual({ shell_snapshot: false, web_search: true });
    expect(parseToml(result.text)).toMatchObject({ other: { shell_snapshot: true } });
  });

  it("replaces a root-level dotted key", () => {
    const input = 'features.shell_snapshot = true\nmodel = "gpt-5.6-sol"\n';

    const result = applyShellSnapshotPolicy(input);

    expect(result.text).not.toContain("features.shell_snapshot");
    expect(parseToml(result.text)).toMatchObject({
      model: "gpt-5.6-sol",
      features: { shell_snapshot: false },
    });
  });

  it("is idempotent across runs", () => {
    const first = applyShellSnapshotPolicy('model = "gpt-5.6-sol"\n');
    const second = applyShellSnapshotPolicy(first.text);

    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
    expect(applyShellSnapshotPolicy(second.text).text).toBe(first.text);
  });

  it("refuses to rewrite an inline features table rather than breaking the file", () => {
    const input = "features = { web_search = true }\n";

    const result = applyShellSnapshotPolicy(input);

    expect(result.changed).toBe(false);
    expect(result.text).toBe(input);
    expect(result.unsupported).toContain("inline table");
  });

  it("accepts an inline features table that already disables shell snapshots", () => {
    const input = "features = { shell_snapshot = false, web_search = true }\n";

    const result = applyShellSnapshotPolicy(input);

    expect(result.changed).toBe(false);
    expect(result.unsupported).toBeUndefined();
    expect(result.text).toBe(input);
  });

  it("accepts a quoted inline features table that already disables shell snapshots", () => {
    const input = '"features" = { "shell_snapshot" = false }\n';

    const result = applyShellSnapshotPolicy(input);

    expect(result.changed).toBe(false);
    expect(result.unsupported).toBeUndefined();
    expect(result.text).toBe(input);
  });

  it("still refuses an inline features table that leaves shell_snapshot enabled", () => {
    const input = "features = { shell_snapshot = true, web_search = true }\n";

    const result = applyShellSnapshotPolicy(input);

    expect(result.changed).toBe(false);
    expect(result.text).toBe(input);
    expect(result.unsupported).toContain("inline table");
  });

  it("matches a features table header followed by a trailing comment", () => {
    const input = 'model = "gpt-5.6-sol"\n\n[features] # operator settings\nweb_search = true\n';

    const result = applyShellSnapshotPolicy(input);

    expect(result.text.match(/^\[features\]/gm)).toHaveLength(1);
    expect(parsedFeatures(result.text)).toEqual({ shell_snapshot: false, web_search: true });
  });

  it("does not accumulate a managed comment across repeated runs against an existing table", () => {
    const input = "[features]\nweb_search = true\n";

    const first = applyShellSnapshotPolicy(input);
    const second = applyShellSnapshotPolicy(first.text);

    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
    expect(first.text.match(/managed by paperclip/g)).toHaveLength(1);
  });

  it("writes into a quoted [\"features\"] table header instead of declaring it twice", () => {
    const input = 'model = "gpt-5.6-sol"\n\n["features"]\nweb_search = true\n';

    const result = applyShellSnapshotPolicy(input);

    expect(result.changed).toBe(true);
    expect(result.text.match(/features/g)?.length).toBeGreaterThan(0);
    expect(result.text).not.toMatch(/^\[features\]$/m);
    expect(parsedFeatures(result.text)).toEqual({ shell_snapshot: false, web_search: true });
  });

  it("overrides a quoted 'shell_snapshot' key instead of leaving a duplicate", () => {
    const input = "[features]\n'shell_snapshot' = true\nweb_search = true\n";

    const result = applyShellSnapshotPolicy(input);

    expect(result.text.match(/shell_snapshot/g)).toHaveLength(1);
    expect(parsedFeatures(result.text)).toEqual({ shell_snapshot: false, web_search: true });
  });

  it("replaces a quoted dotted key \"features\".\"shell_snapshot\"", () => {
    const input = '"features"."shell_snapshot" = true\nmodel = "gpt-5.6-sol"\n';

    const result = applyShellSnapshotPolicy(input);

    expect(result.text).not.toContain('"features"."shell_snapshot"');
    expect(parseToml(result.text)).toMatchObject({
      model: "gpt-5.6-sol",
      features: { shell_snapshot: false },
    });
  });

  it("refuses to rewrite a quoted inline features table rather than breaking the file", () => {
    const input = '"features" = { web_search = true }\n';

    const result = applyShellSnapshotPolicy(input);

    expect(result.changed).toBe(false);
    expect(result.text).toBe(input);
    expect(result.unsupported).toContain("inline table");
  });

  it("reports rather than writes when the rewrite would produce invalid TOML", () => {
    // Two `[features]` headers is invalid TOML; only the first is recognized by
    // the line-oriented rewrite, so the naive rewrite would leave the second
    // header's body orphaned under a duplicate table. The output-validation
    // step must catch this before it ever reaches disk.
    const input = "[features]\nweb_search = true\n[features]\nother = true\n";

    const result = applyShellSnapshotPolicy(input);

    expect(() => parseToml(input)).toThrow();
    expect(result.changed).toBe(false);
    expect(result.text).toBe(input);
    expect(result.unsupported).toContain("invalid TOML");
  });
});

describe("enforceCodexShellSnapshotPolicy", () => {
  it("creates config.toml when the Codex home has none", async () => {
    const home = await createCodexHome();

    const notes = await enforceCodexShellSnapshotPolicy(home);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Disabled Codex shell snapshots");
    expect(parseToml(await readConfig(home))).toEqual({ features: { shell_snapshot: false } });
  });

  it("preserves a seeded operator config and stays quiet on the second run", async () => {
    const home = await createCodexHome('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n');

    expect(await enforceCodexShellSnapshotPolicy(home)).toHaveLength(1);
    const afterFirst = await readConfig(home);
    expect(parseToml(afterFirst)).toMatchObject({
      model: "gpt-5.6-sol",
      model_reasoning_effort: "high",
      features: { shell_snapshot: false },
    });

    expect(await enforceCodexShellSnapshotPolicy(home)).toEqual([]);
    expect(await readConfig(home)).toBe(afterFirst);
  });

  it("blocks the launch instead of starting Codex unprotected on an inline features table", async () => {
    const home = await createCodexHome("features = { web_search = true }\n");

    await expect(enforceCodexShellSnapshotPolicy(home)).rejects.toThrow(
      CodexShellSnapshotPolicyError,
    );
    await expect(enforceCodexShellSnapshotPolicy(home)).rejects.toThrow(
      /refusing to launch codex/i,
    );
    expect(await readConfig(home)).toBe("features = { web_search = true }\n");
  });

  it.skipIf(process.platform === "win32")("blocks the launch when config.toml cannot be read", async () => {
    const home = await createCodexHome('model = "gpt-5.6-sol"\n');
    const configPath = path.join(home, "config.toml");
    await fs.chmod(configPath, 0o000);

    try {
      await expect(enforceCodexShellSnapshotPolicy(home)).rejects.toThrow(
        CodexShellSnapshotPolicyError,
      );
    } finally {
      await fs.chmod(configPath, 0o600);
    }
  });

  it.skipIf(process.platform === "win32")("creates a new config.toml owner-only, since it may carry provider secrets", async () => {
    const home = await createCodexHome();

    await enforceCodexShellSnapshotPolicy(home);

    const mode = (await fs.stat(path.join(home, "config.toml"))).mode & 0o777;
    expect(hasGroupOrOtherAccess(mode)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("tightens an existing config.toml to owner-only across the rewrite", async () => {
    const home = await createCodexHome('model = "gpt-5.6-sol"\n');
    await fs.chmod(path.join(home, "config.toml"), 0o640);

    await enforceCodexShellSnapshotPolicy(home);

    const mode = (await fs.stat(path.join(home, "config.toml"))).mode & 0o777;
    expect(hasGroupOrOtherAccess(mode)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("creates the Codex home private at policy enforcement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kee216-codex-home-"));
    cleanupRoots.push(root);
    const home = path.join(root, "codex-home");
    await fs.mkdir(home, { recursive: true, mode: 0o755 });

    await enforceCodexShellSnapshotPolicy(home);

    const mode = (await fs.stat(home)).mode & 0o777;
    expect(hasGroupOrOtherAccess(mode)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("narrows an already-created world-readable Codex home before launch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kee216-codex-home-"));
    cleanupRoots.push(root);
    const home = path.join(root, "codex-home");
    await fs.mkdir(home, { recursive: true, mode: 0o755 });

    await enforceCodexShellSnapshotPolicy(home);

    const mode = (await fs.stat(home)).mode & 0o777;
    expect(hasGroupOrOtherAccess(mode)).toBe(false);
  });

  it("does not collide when two invocations race on the same Codex home", async () => {
    const home = await createCodexHome('model = "gpt-5.6-sol"\n');

    const [first, second] = await Promise.all([
      enforceCodexShellSnapshotPolicy(home),
      enforceCodexShellSnapshotPolicy(home),
    ]);

    expect([...first, ...second].some((line) => line.includes("Could not write"))).toBe(false);
    expect(parseToml(await readConfig(home))).toMatchObject({
      model: "gpt-5.6-sol",
      features: { shell_snapshot: false },
    });
  });

  // KEE-216 review finding: `if (!policy.changed) return []` used to run before
  // the mkdir/chmod/writeFile, so a config whose policy text was already correct
  // kept whatever mode it happened to have. A 0644 config.toml that can carry
  // literal provider secrets stayed world-readable forever. Assert the achieved
  // mode on disk, not the argument that was passed to chmod.
  it.skipIf(process.platform === "win32")(
    "tightens a policy-compliant config that was left world-readable",
    async () => {
      // Write a config through the policy once so it is genuinely compliant,
      // then re-loosen its mode to reproduce the reported condition.
      const home = await createCodexHome('model = "gpt-5.6-sol"\n');
      await enforceCodexShellSnapshotPolicy(home);
      const compliant = await readConfig(home);
      expect(applyShellSnapshotPolicy(compliant).changed).toBe(false);

      const configPath = path.join(home, "config.toml");
      await fs.chmod(configPath, 0o644);
      await fs.chmod(home, 0o755);
      expect(hasGroupOrOtherAccess((await fs.stat(configPath)).mode)).toBe(true);

      const notes = await enforceCodexShellSnapshotPolicy(home);

      // Nothing is rewritten — that part is correct — but the mode must still be
      // fixed, which is exactly what the old early return skipped.
      expect(notes).toEqual([]);
      expect(hasGroupOrOtherAccess((await fs.stat(configPath)).mode)).toBe(false);
      expect(hasGroupOrOtherAccess((await fs.stat(home)).mode)).toBe(false);
      expect(await readConfig(home)).toBe(compliant);
    },
  );
});

describe("multiline string bodies are not structure", () => {
  // KEE-216 review finding: a `[features]` line inside a `'''` value matched the
  // table-header regex, so the rewriter injected the policy INTO the string. The
  // result still parsed — which is exactly why the old self-parse check passed it
  // — but `features.shell_snapshot` stayed undefined and Codex launched with
  // snapshots on. These assert the parsed outcome, not that the text parses.
  it("disables shell snapshots even when [features] appears inside a multiline string", () => {
    const input = [
      'model = "gpt-5.6-sol"',
      "developer_instructions = '''",
      "Be careful with this config.",
      "[features]",
      "telemetry = false",
      "'''",
      "",
    ].join("\n");

    const result = applyShellSnapshotPolicy(input);

    expect(result.unsupported).toBeUndefined();
    // The decisive assertion: the policy is in force in the PARSED structure.
    expect(parsedFeatures(result.text)).toMatchObject({ shell_snapshot: false });
    // And the operator's string content survives untouched.
    const parsed = parseToml(result.text) as { developer_instructions?: string };
    expect(parsed.developer_instructions).toContain("[features]");
    expect(parsed.developer_instructions).toContain("Be careful with this config.");
  });

  it("does not treat a [features] line inside a basic multiline string as a table", () => {
    const input = ['notes = """', "[features]", '"""', ""].join("\n");

    const result = applyShellSnapshotPolicy(input);

    expect(result.unsupported).toBeUndefined();
    expect(parsedFeatures(result.text)).toMatchObject({ shell_snapshot: false });
    // The string body survives verbatim, including the newline before the
    // closing delimiter that a multi-line TOML string keeps.
    expect((parseToml(result.text) as { notes?: string }).notes).toBe("[features]\n");
  });

  it("keeps a competing shell_snapshot line inside a string from colliding with the policy", () => {
    const input = [
      "instructions = '''",
      "shell_snapshot = true",
      "'''",
      "[features]",
      "shell_snapshot = true",
      "",
    ].join("\n");

    const result = applyShellSnapshotPolicy(input);

    expect(result.unsupported).toBeUndefined();
    expect(parsedFeatures(result.text)).toMatchObject({ shell_snapshot: false });
    // The in-string text is preserved exactly as the operator wrote it.
    const parsed = parseToml(result.text) as { instructions?: string };
    expect(parsed.instructions).toBe("shell_snapshot = true\n");
  });

  it("refuses rather than writing when the policy cannot be confirmed in the parsed result", () => {
    // `features` defined as an inline table is a shape this line-oriented
    // rewriter will not merge. It must report, never silently claim success.
    const input = "features = { web_search = true }\n";

    const result = applyShellSnapshotPolicy(input);

    expect(result.changed).toBe(false);
    expect(result.unsupported).toBeTruthy();
  });
});
