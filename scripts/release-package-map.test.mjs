import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReleasePackagePlan,
  checkConfiguration,
  findSkillsPackages,
  findUnpublishableWorkspaceEdges,
  getReleasePackages,
} from "./release-package-map.mjs";

function pkg(name, { publishFromCi, ...deps } = {}) {
  return { name, dir: name, publishFromCi, pkg: { name, ...deps } };
}

test("release package manifest covers all public packages with explicit CI enrollment", () => {
  const packages = buildReleasePackagePlan();
  assert.ok(packages.length > 0);
  assert.ok(packages.every((pkg) => typeof pkg.publishFromCi === "boolean"));
});

test("release package list only contains CI-enrolled packages", () => {
  const enabledPackages = getReleasePackages();
  assert.ok(enabledPackages.length > 0);
  assert.ok(enabledPackages.every((pkg) => pkg.publishFromCi === true));
});

test("release package list publishes the installable channel entrypoint last", () => {
  const enabledPackages = getReleasePackages();

  assert.equal(enabledPackages.at(-1)?.name, "paperclipai");
  assert.ok(enabledPackages.slice(0, -1).some((pkg) => pkg.name === "@paperclipai/server"));
});

test("release package list keeps runtime workspace dependencies ahead of consumers", () => {
  const enabledPackages = getReleasePackages();
  const publishIndexByName = new Map(enabledPackages.map((pkg, index) => [pkg.name, index]));

  for (const pkg of enabledPackages) {
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [dependencyName, spec] of Object.entries(pkg.pkg[section] ?? {})) {
        if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
        const dependencyIndex = publishIndexByName.get(dependencyName);
        if (dependencyIndex === undefined) continue;

        assert.ok(
          dependencyIndex < publishIndexByName.get(pkg.name),
          `${dependencyName} must publish before ${pkg.name}`,
        );
      }
    }
  }
});

test("Hermes release surface publishes the unified built-in package and keeps gateway as a shim", () => {
  const packages = buildReleasePackagePlan();
  const hermes = packages.find((pkg) => pkg.name === "@paperclipai/hermes-paperclip-adapter");
  const gatewayShim = packages.find((pkg) => pkg.name === "@paperclipai/adapter-hermes-gateway");

  assert.equal(hermes?.dir, "packages/adapters/hermes");
  assert.equal(hermes?.publishFromCi, true);
  assert.equal(gatewayShim?.dir, "packages/adapters/hermes-gateway");
  assert.equal(gatewayShim?.publishFromCi, false);
});

test("release package configuration validates successfully", () => {
  assert.doesNotThrow(() => checkConfiguration());
});

// KEE-1129: release.sh used to copy skills/ into a hand-written list of three
// packages while seven declared "skills" in files[], so cursor-local,
// gemini-local and opencode-local published without a skills/ directory. The
// set must be derived from files[], and the adapters that resolve skills at
// runtime must stay in it.
test("every published package that declares skills in files[] is in the skills staging set", () => {
  const skillsDirs = findSkillsPackages(getReleasePackages()).map((pkg) => pkg.dir);

  assert.deepEqual(
    skillsDirs,
    [
      "packages/adapters/claude-local",
      "packages/adapters/codex-local",
      "packages/adapters/cursor-local",
      "packages/adapters/gemini-local",
      "packages/adapters/opencode-local",
      "packages/adapters/hermes",
      "server",
    ],
    "the skills staging set must be derived from files[] and cover every package that claims it",
  );
});

test("no published package claims skills in files[] without appearing in the staging set", () => {
  const selected = new Set(findSkillsPackages(getReleasePackages()).map((pkg) => pkg.dir));
  const missing = getReleasePackages().filter(
    (pkg) => Array.isArray(pkg.pkg.files) && pkg.pkg.files.includes("skills") && !selected.has(pkg.dir),
  );

  assert.deepEqual(missing, [], "every skills-claiming package must be staged");
});

test("packages that do not claim skills in files[] are never staged", () => {
  const selected = new Set(findSkillsPackages(getReleasePackages()).map((pkg) => pkg.dir));

  for (const dir of ["cli", "ui", "packages/adapters/grok-local", "packages/adapters/kimi-local"]) {
    assert.ok(!selected.has(dir), `${dir} does not declare skills in files[] and must not be staged`);
  }
});

test("guard flags a publishFromCi:true package depending on a publishFromCi:false package", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      dependencies: { "@paperclipai/skills-catalog": "workspace:*" },
    }),
    pkg("@paperclipai/skills-catalog", { publishFromCi: false }),
  ]);

  assert.equal(problems.length, 1);
  assert.match(problems[0], /@paperclipai\/server/);
  assert.match(problems[0], /@paperclipai\/skills-catalog/);
});

test("guard inspects optional and peer dependency sections too", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      optionalDependencies: { "@paperclipai/opt": "workspace:^" },
      peerDependencies: { "@paperclipai/peer": "workspace:*" },
    }),
    pkg("@paperclipai/opt", { publishFromCi: false }),
    pkg("@paperclipai/peer", { publishFromCi: false }),
  ]);

  assert.equal(problems.length, 2);
});

test("guard treats a workspace dep on an unknown @paperclipai package as unpublishable", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      dependencies: { "@paperclipai/private-internal": "workspace:*" },
    }),
  ]);

  assert.equal(problems.length, 1);
});

test("guard allows true->true workspace edges", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      dependencies: { "@paperclipai/shared": "workspace:*" },
    }),
    pkg("@paperclipai/shared", { publishFromCi: true }),
  ]);

  assert.deepEqual(problems, []);
});

test("guard ignores non-workspace specs, non-internal deps, and edges from off-train packages", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      dependencies: {
        "@paperclipai/pinned": "0.3.1",
        zod: "^3.0.0",
      },
    }),
    pkg("@paperclipai/pinned", { publishFromCi: false }),
    pkg("@paperclipai/offtrain", {
      publishFromCi: false,
      dependencies: { "@paperclipai/also-off": "workspace:*" },
    }),
    pkg("@paperclipai/also-off", { publishFromCi: false }),
  ]);

  assert.deepEqual(problems, []);
});

test("the live release manifest has no unpublishable workspace edges", () => {
  assert.deepEqual(findUnpublishableWorkspaceEdges(buildReleasePackagePlan()), []);
});
