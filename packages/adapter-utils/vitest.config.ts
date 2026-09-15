import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The 57 files the root project entry already picked up by default. Stated
    // explicitly so adding this config cannot silently change which tests run.
    include: ["src/**/*.test.ts"],
    // The acpx-engine suites are the heavyweight end of this package: they run the
    // real engine over real temp directories and, in places, real child processes,
    // with only the provider runtime faked. `execute.test.ts` alone is 178 tests and
    // ~59s of wall clock.
    //
    // Measured on a 12-core host: `keeps Claude startup model handling and Gemini
    // session config handling unchanged` costs ~1.8s run on its own, against
    // vitest's default 5s testTimeout. A 2.8x margin does not survive the full
    // package running across every worker — it was killed at 5120ms in a full run,
    // and the same suites pass every time they run alone. That thin margin, not a
    // shared resource, is why a *different* test in these two files failed on each
    // full-package run: whichever heavy test the scheduler happened to starve.
    //
    // 15s is ~8x the observed uncontended cost of the worst test, matching the
    // headroom `server/vitest.config.ts` gives its suites for the same reason, and
    // still fails a genuinely hung test quickly enough to be useful. Raise this only
    // with a measurement; if a test needs more than this, it is too slow.
    testTimeout: 15000,
  },
});
