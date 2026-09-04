import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(".");

function typescriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("reviewed v4 kernel architecture boundary", () => {
  it("has no caller-minted permit or public MigrationCoordinator v4 mutator", () => {
    expect(existsSync(join(repositoryRoot, "src/migration/v4-execution-permit.ts"))).toBe(false);
    const coordinator = readFileSync(join(repositoryRoot, "src/migration/coordinator.ts"), "utf8");
    expect(coordinator).not.toMatch(/\bmigrateToV4\s*\(/);
    expect(coordinator).not.toContain("v4Execution");
  });

  it("limits the internal v4 kernel to production composition and test support", () => {
    const importPath = ["internal", "reviewed-v4-kernel"].join("/");
    const importers = ["src", "tests"]
      .flatMap((root) => typescriptFiles(join(repositoryRoot, root)))
      .filter((path) => !path.endsWith("reviewed-v4-kernel-boundary.test.ts"))
      .filter((path) => readFileSync(path, "utf8").includes(importPath))
      .map((path) => relative(repositoryRoot, path))
      .sort();

    expect(importers).toEqual([
      "src/migration/reviewed-v4-production-process.ts",
      "tests/helpers/authorized-v4-coordinator.ts",
    ]);
  });
});
