import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INSTALL_MANIFEST_VERSION,
  buildNextManifest,
  defaultManagedSkillHomes,
  migrateManagedSkillLinks,
  resolveInstallStorePaths,
  type InstallManifest,
  type InstallRecord,
} from "../install-store.js";

/**
 * A managed skill link lives at <skills home>/<name> and resolves to
 * <payload>/node_modules/@paperclipai/server/skills/<name>.
 */
const SKILL_ROOT_RELATIVE = path.join(
  "node_modules",
  "@paperclipai",
  "server",
  "skills",
);

function payloadRecord(payloadPath: string, version: string): InstallRecord {
  return {
    source: "git",
    version,
    channel: "pinned",
    payloadPath,
    sha: version.padEnd(40, "0").slice(0, 40),
    installedAt: `2026-09-29T00:00:00.000Z`,
  };
}

function manifestFor(
  payloadPath: string,
  version: string,
  previous: InstallRecord[] = [],
): InstallManifest {
  return { schemaVersion: INSTALL_MANIFEST_VERSION, ...payloadRecord(payloadPath, version), previous };
}

function skillSource(payloadPath: string, name: string): string {
  return path.join(payloadPath, SKILL_ROOT_RELATIVE, name);
}

describe("migrateManagedSkillLinks", () => {
  let root: string;
  let paths: ReturnType<typeof resolveInstallStorePaths>;
  let skillsHome: string;
  let oldPayload: string;
  let newPayload: string;
  let foreignPayload: string;

  function writeSkill(payloadPath: string, name: string): void {
    const dir = skillSource(payloadPath, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${name}\n`);
  }

  function link(name: string, target: string): string {
    const linkPath = path.join(skillsHome, name);
    fs.symlinkSync(target, linkPath, "dir");
    return linkPath;
  }

  function resolveLink(name: string): string {
    return fs.realpathSync(path.join(skillsHome, name));
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-skill-migration-"));
    paths = resolveInstallStorePaths({
      homeDir: path.join(root, "home"),
      paperclipHome: path.join(root, "home", ".paperclip"),
    });
    skillsHome = defaultManagedSkillHomes(paths)[0];
    fs.mkdirSync(skillsHome, { recursive: true });
    oldPayload = path.join(paths.installsRoot, "git", "old000000000");
    newPayload = path.join(paths.installsRoot, "git", "new111111111");
    foreignPayload = path.join(root, "another-install", "payload");
    for (const payload of [oldPayload, newPayload, foreignPayload]) {
      writeSkill(payload, "paperclip");
      writeSkill(payload, "aux-skill");
    }
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("migrates a link out of the retained previous payload on a forward advance", () => {
    const linkPath = link("paperclip", skillSource(oldPayload, "paperclip"));
    const manifest = manifestFor(newPayload, "2.0.0", [payloadRecord(oldPayload, "1.0.0")]);

    const migrations = migrateManagedSkillLinks(manifest, paths);

    expect(migrations).toHaveLength(1);
    expect(migrations[0].link).toBe(linkPath);
    expect(migrations[0].from).toBe(skillSource(oldPayload, "paperclip"));
    expect(migrations[0].to).toBe(skillSource(newPayload, "paperclip"));
    expect(resolveLink("paperclip")).toBe(fs.realpathSync(skillSource(newPayload, "paperclip")));
  });

  it("leaves no managed link stranded in the previous payload after an advance", () => {
    link("paperclip", skillSource(oldPayload, "paperclip"));
    link("aux-skill", skillSource(oldPayload, "aux-skill"));
    const manifest = manifestFor(newPayload, "2.0.0", [payloadRecord(oldPayload, "1.0.0")]);

    migrateManagedSkillLinks(manifest, paths);

    for (const name of ["paperclip", "aux-skill"]) {
      expect(resolveLink(name)).toBe(fs.realpathSync(skillSource(newPayload, name)));
    }
  });

  it("migrates a link back into the rolled-back payload when the old payload is retained", () => {
    // State after the advance above: the link points at the new payload, which becomes
    // `previous` on rollback while staying on disk.
    link("paperclip", skillSource(newPayload, "paperclip"));
    const rolledBack = manifestFor(oldPayload, "1.0.0", [payloadRecord(newPayload, "2.0.0")]);

    const migrations = migrateManagedSkillLinks(rolledBack, paths);

    expect(migrations).toHaveLength(1);
    expect(resolveLink("paperclip")).toBe(fs.realpathSync(skillSource(oldPayload, "paperclip")));
  });

  it("refuses a link that resolves into a foreign installation", () => {
    const foreignLink = link("paperclip", skillSource(foreignPayload, "paperclip"));
    const manifest = manifestFor(newPayload, "2.0.0", [payloadRecord(oldPayload, "1.0.0")]);

    const migrations = migrateManagedSkillLinks(manifest, paths);

    expect(migrations).toEqual([]);
    expect(fs.readlinkSync(foreignLink)).toBe(skillSource(foreignPayload, "paperclip"));
    expect(resolveLink("paperclip")).toBe(fs.realpathSync(skillSource(foreignPayload, "paperclip")));
  });

  it("refuses a link into a payload that is neither current nor in the retained lineage", () => {
    // A third, unrelated payload inside installsRoot that the manifest does not claim.
    const orphanPayload = path.join(paths.installsRoot, "git", "orphan00000000");
    writeSkill(orphanPayload, "paperclip");
    const orphanLink = link("paperclip", skillSource(orphanPayload, "paperclip"));
    const manifest = manifestFor(newPayload, "2.0.0", [payloadRecord(oldPayload, "1.0.0")]);

    const migrations = migrateManagedSkillLinks(manifest, paths);

    expect(migrations).toEqual([]);
    expect(fs.readlinkSync(orphanLink)).toBe(skillSource(orphanPayload, "paperclip"));
  });

  it("never touches an auxiliary skill that does not resolve into an owned payload", () => {
    const auxiliaryRoot = path.join(root, "auxiliary");
    fs.mkdirSync(auxiliaryRoot, { recursive: true });
    const auxiliaryLink = path.join(auxiliaryRoot, "typesafe-ai");
    fs.symlinkSync(path.join(root, "elsewhere", "typesafe-ai"), auxiliaryLink, "dir");
    // Mirror the real layout: auxiliary links live in the same skills home.
    const realAuxLink = link("typesafe-ai", path.join(root, "elsewhere", "typesafe-ai"));
    const manifest = manifestFor(newPayload, "2.0.0", [payloadRecord(oldPayload, "1.0.0")]);

    const migrations = migrateManagedSkillLinks(manifest, paths);

    expect(migrations).toEqual([]);
    expect(fs.readlinkSync(realAuxLink)).toBe(path.join(root, "elsewhere", "typesafe-ai"));
  });

  it("ignores a plain directory that shares a name with a managed skill", () => {
    const realDirectory = path.join(skillsHome, "paperclip");
    fs.mkdirSync(realDirectory, { recursive: true });
    const manifest = manifestFor(newPayload, "2.0.0", [payloadRecord(oldPayload, "1.0.0")]);

    const migrations = migrateManagedSkillLinks(manifest, paths);

    expect(migrations).toEqual([]);
    expect(fs.lstatSync(realDirectory).isDirectory()).toBe(true);
    expect(fs.lstatSync(realDirectory).isSymbolicLink()).toBe(false);
  });

  it("is idempotent when the link already points at the active payload", () => {
    link("paperclip", skillSource(newPayload, "paperclip"));
    const manifest = manifestFor(newPayload, "2.0.0", [payloadRecord(oldPayload, "1.0.0")]);

    expect(migrateManagedSkillLinks(manifest, paths)).toEqual([]);
    expect(resolveLink("paperclip")).toBe(fs.realpathSync(skillSource(newPayload, "paperclip")));
  });

  it("leaves a link alone when the skill no longer exists in the new payload", () => {
    fs.rmSync(skillSource(newPayload, "paperclip"), { recursive: true, force: true });
    const linkPath = link("paperclip", skillSource(oldPayload, "paperclip"));
    const manifest = manifestFor(newPayload, "2.0.0", [payloadRecord(oldPayload, "1.0.0")]);

    const migrations = migrateManagedSkillLinks(manifest, paths);

    expect(migrations).toEqual([]);
    expect(fs.readlinkSync(linkPath)).toBe(skillSource(oldPayload, "paperclip"));
  });

  it("handles a relative link target the same as an absolute one", () => {
    fs.symlinkSync(
      path.relative(skillsHome, skillSource(oldPayload, "paperclip")),
      path.join(skillsHome, "paperclip"),
      "dir",
    );
    const manifest = manifestFor(newPayload, "2.0.0", [payloadRecord(oldPayload, "1.0.0")]);

    migrateManagedSkillLinks(manifest, paths);

    expect(resolveLink("paperclip")).toBe(fs.realpathSync(skillSource(newPayload, "paperclip")));
  });

  it("migrates every managed link in one pass across several homes", () => {
    const secondHome = path.join(root, "home2", ".hermes", "skills");
    fs.mkdirSync(secondHome, { recursive: true });
    fs.symlinkSync(skillSource(oldPayload, "paperclip"), path.join(secondHome, "paperclip"), "dir");
    link("paperclip", skillSource(oldPayload, "paperclip"));
    const manifest = manifestFor(newPayload, "2.0.0", [payloadRecord(oldPayload, "1.0.0")]);

    const migrations = migrateManagedSkillLinks(manifest, paths, { skillsHomes: [skillsHome, secondHome] });

    expect(migrations).toHaveLength(2);
    expect(fs.realpathSync(path.join(skillsHome, "paperclip"))).toBe(
      fs.realpathSync(skillSource(newPayload, "paperclip")),
    );
    expect(fs.realpathSync(path.join(secondHome, "paperclip"))).toBe(
      fs.realpathSync(skillSource(newPayload, "paperclip")),
    );
  });

  it("carries the migration through buildNextManifest without losing lineage", () => {
    const current = manifestFor(newPayload, "2.0.0", [payloadRecord(oldPayload, "1.0.0")]);
    const third = path.join(paths.installsRoot, "git", "third22222222");
    writeSkill(third, "paperclip");
    link("paperclip", skillSource(third, "paperclip"));

    // A payload dropped from the retained lineage is no longer ours to migrate.
    const next = buildNextManifest(payloadRecord(third, "3.0.0"), current);

    expect(next.previous.map((entry) => path.basename(entry.payloadPath))).toEqual([
      "new111111111",
      "old000000000",
    ]);
    expect(migrateManagedSkillLinks(next, paths)).toEqual([]);
  });
});
