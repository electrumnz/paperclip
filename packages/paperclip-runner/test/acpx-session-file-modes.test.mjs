import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const roots = [];
const baseRecord = {
  schema: "acpx.session.v1",
  acpxRecordId: "kee216-mode-test",
  acpSessionId: "kee216-mode-test",
  agentCommand: "fixture",
  cwd: "/tmp",
  createdAt: "2026-09-24T00:00:00.000Z",
  lastUsedAt: "2026-09-24T00:00:00.000Z",
  lastSeq: 0,
  eventLog: { schema: "acpx.session-event-log.v1", segments: [] },
  messages: [],
  updated_at: "2026-09-24T00:00:00.000Z",
  cumulative_token_usage: {},
  request_token_usage: {},
};

const fixtures = [
  {
    label: "adapter-utils acpx@0.12.0",
    require: createRequire(join(repositoryRoot, "packages/adapter-utils/package.json")),
  },
  {
    label: "paperclip-runner acpx@0.13.1",
    require: createRequire(join(repositoryRoot, "packages/paperclip-runner/package.json")),
  },
];

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

for (const { label, require } of fixtures) {
  test(`${label} creates session directories and records private`, async () => {
    const runtimeUrl = pathToFileURL(require.resolve("acpx/runtime")).href;
    const { createRuntimeStore } = await import(runtimeUrl);
    const root = await mkdtemp(join(tmpdir(), "kee216-acpx-mode-"));
    roots.push(root);
    const stateDir = join(root, "state");

    // Concurrent saves also exercise ACPX 0.12.0's new UUID temp suffix.
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      createRuntimeStore({ stateDir }).save({
        ...baseRecord,
        acpxRecordId: `${baseRecord.acpxRecordId}-${index}`,
      })
    ));

    const sessionsDir = join(stateDir, "sessions");
    const sessionDirMode = (await stat(sessionsDir)).mode & 0o777;
    const files = (await readdir(sessionsDir))
      .filter((name) => name.endsWith(".json") && name !== "index.json");
    assert.equal(sessionDirMode & 0o077, 0, "session directory must have no group or other bits");
    assert.equal(files.length, 8);
    for (const file of files) {
      const filePath = join(sessionsDir, file);
      assert.equal((await stat(filePath)).mode & 0o077, 0, `${file} must have no group or other bits`);
    }
  });
}
