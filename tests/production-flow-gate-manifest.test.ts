import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const sourceRunner = resolve("scripts/run-bounded-tests.mjs");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const createFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-production-manifest-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "tests", "nested"), { recursive: true });
  mkdirSync(join(root, "node_modules", "vitest"), { recursive: true });
  copyFileSync(sourceRunner, join(root, "scripts", "run-bounded-tests.mjs"));
  for (const file of [
    "tests/ordinary.test.ts",
    "tests/nested/deep.test.ts",
    "tests/nested/eval-not-excluded.test.ts",
    "tests/eval-excluded.test.ts",
  ]) {
    writeFileSync(join(root, file), "// fixture\n");
  }
  writeFileSync(join(root, "node_modules", "vitest", "vitest.mjs"), "process.exit(0);\n");
  const manifest = {
    schemaVersion: "bounded-test-manifest/v2",
    name: "production-flow-gate",
    defaultTimeoutMs: 120_000,
    migrationTimeoutMs: 180_000,
    exhaustiveTimeoutMs: 300_000,
    tests: [
      "tests/ordinary.test.ts",
      "tests/nested/deep.test.ts",
      "tests/nested/eval-not-excluded.test.ts",
    ],
    migrationTests: [],
    exhaustiveTests: [],
  };
  const writeManifest = (value = manifest) => {
    const path = join(root, "scripts", "production-flow-gate.manifest.json");
    writeFileSync(path, `${JSON.stringify(value)}\n`);
    return path;
  };
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [join(root, "scripts", "run-bounded-tests.mjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    return {
      status: result.status,
      summary: JSON.parse(result.stdout.trim()) as {
        gate: string;
        status: string;
        error?: string;
        totals?: { files: number };
      },
    };
  };
  return { manifest, run, writeManifest };
};

describe("production flow gate manifest completeness", () => {
  it("requires every recursive non-eval test and excludes only root tests/eval-*", () => {
    const fixture = createFixture();
    fixture.writeManifest();

    const result = fixture.run();

    expect(result).toMatchObject({
      status: 0,
      summary: {
        gate: "production-flow-gate",
        status: "passed",
        totals: { files: 3 },
      },
    });
  });

  it("rejects a missing recursive non-eval test", () => {
    const fixture = createFixture();
    fixture.writeManifest({
      ...fixture.manifest,
      tests: fixture.manifest.tests.filter((file) => file !== "tests/nested/deep.test.ts"),
    });

    const result = fixture.run();

    expect(result.status).toBe(2);
    expect(result.summary).toMatchObject({ gate: "configuration", status: "configuration_error" });
    expect(result.summary.error).toMatch(/missing.*tests\/nested\/deep\.test\.ts/i);
  });

  it("rejects duplicate, excluded eval, and nonexistent manifest entries", () => {
    const fixture = createFixture();
    const cases = [
      {
        manifest: { ...fixture.manifest, tests: [...fixture.manifest.tests, "tests/ordinary.test.ts"] },
        error: /duplicate/i,
      },
      {
        manifest: { ...fixture.manifest, tests: [...fixture.manifest.tests, "tests/eval-excluded.test.ts"] },
        error: /eval.*excluded|excluded.*eval/i,
      },
      {
        manifest: { ...fixture.manifest, tests: [...fixture.manifest.tests, "tests/not-present.test.ts"] },
        error: /not-present|ENOENT/i,
      },
    ];

    for (const testCase of cases) {
      const manifestPath = fixture.writeManifest(testCase.manifest);
      const result = fixture.run("--manifest", manifestPath);
      expect(result.status).toBe(2);
      expect(result.summary).toMatchObject({ gate: "configuration", status: "configuration_error" });
      expect(result.summary.error).toMatch(testCase.error);
    }
  });

  it("keeps --file explicitly ad-hoc", () => {
    const fixture = createFixture();

    const result = fixture.run("--file", "tests/ordinary.test.ts");

    expect(result).toMatchObject({
      status: 0,
      summary: { gate: "ad-hoc-bounded-tests", status: "passed", totals: { files: 1 } },
    });
    expect(result.summary.gate).not.toBe("production-flow-gate");
  });
});
