// Regression coverage for the git-install packaging failure in KEE-1123.
//
// `paperclipai install --repo ... --ref <sha>` stages @paperclipai/server through
// scripts/prepare-bundled-package.mjs, and a fresh git checkout has neither
// `server/ui-dist` (gitignored) nor `server/skills` (copied in by release.sh).
// The copy loop used to cpSync() both unconditionally and abort the whole install
// with ENOENT. It must instead copy what exists and report what it skipped, so
// the caller can decide whether the gap is acceptable.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const { copyPackageFiles } = await import(join(scriptDir, "prepare-bundled-package.mjs"));

function makeSourcePackage() {
  const root = mkdtempSync(join(tmpdir(), "prepare-bundled-package-"));
  const sourceDir = join(root, "source");
  mkdirSync(sourceDir, { recursive: true });
  return { root, sourceDir };
}

test("copies every files[] entry that exists in the checkout", () => {
  const { root, sourceDir } = makeSourcePackage();
  try {
    mkdirSync(join(sourceDir, "dist"), { recursive: true });
    writeFileSync(join(sourceDir, "dist", "index.js"), "export {};\n");

    const destinationDir = join(root, "staging");
    mkdirSync(destinationDir, { recursive: true });
    const result = copyPackageFiles(sourceDir, destinationDir, ["dist", "ui-dist", "skills"]);

    assert.deepEqual(result.copied, ["dist"]);
    assert.deepEqual(result.missing, ["ui-dist", "skills"], "absent entries must be reported, not dropped");
    assert.equal(readFileSync(join(destinationDir, "dist", "index.js"), "utf8"), "export {};\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not throw when files[] entries are absent (KEE-1123 ENOENT)", () => {
  const { root, sourceDir } = makeSourcePackage();
  try {
    const destinationDir = join(root, "staging");
    mkdirSync(destinationDir, { recursive: true });
    // Nothing exists: this is the exact fresh-checkout shape that used to abort
    // the whole install with `ENOENT: no such file or directory, lstat ...ui-dist`.
    const result = copyPackageFiles(sourceDir, destinationDir, ["dist", "ui-dist", "skills"]);

    assert.deepEqual(result.copied, []);
    assert.deepEqual(result.missing, ["dist", "ui-dist", "skills"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves nested directory contents and handles a missing entry list", () => {
  const { root, sourceDir } = makeSourcePackage();
  try {
    mkdirSync(join(sourceDir, "skills", "paperclip"), { recursive: true });
    writeFileSync(join(sourceDir, "skills", "paperclip", "SKILL.md"), "# skill\n");

    const destinationDir = join(root, "staging");
    mkdirSync(destinationDir, { recursive: true });
    const result = copyPackageFiles(sourceDir, destinationDir, ["skills", "ui-dist"]);

    assert.deepEqual(result.copied, ["skills"]);
    assert.deepEqual(result.missing, ["ui-dist"]);
    assert.equal(readFileSync(join(destinationDir, "skills", "paperclip", "SKILL.md"), "utf8"), "# skill\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an existing destination is not polluted by a skipped entry", () => {
  const { root, sourceDir } = makeSourcePackage();
  try {
    const destinationDir = join(root, "staging");
    mkdirSync(join(sourceDir, "dist"), { recursive: true });
    writeFileSync(join(sourceDir, "dist", "index.js"), "export {};\n");
    cpSync(sourceDir, destinationDir, { recursive: true });

    copyPackageFiles(sourceDir, destinationDir, ["dist"]);
    // Re-running after ui-dist is added must not leave a stale empty directory.
    mkdirSync(join(sourceDir, "ui-dist"), { recursive: true });
    writeFileSync(join(sourceDir, "ui-dist", "index.html"), "<html></html>\n");
    const result = copyPackageFiles(sourceDir, destinationDir, ["dist", "ui-dist"]);

    assert.deepEqual(result.missing, []);
    assert.equal(readFileSync(join(destinationDir, "ui-dist", "index.html"), "utf8"), "<html></html>\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
