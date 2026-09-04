import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const launcher = resolve("scripts/agent-collab-launcher.mjs");

describe("source launchers", () => {
  it("executes current source without importing stale compiled JavaScript", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "agent-collab-launch-state-"));
    const compiledCli = resolve("dist/cli.js");
    try {
      mkdirSync(dirname(compiledCli), { recursive: true });
      writeFileSync(compiledCli, "throw new Error('STALE_DIST_EXECUTED');\n");

      const launched = spawnSync(process.execPath, [launcher, "doctor"], {
        cwd: resolve("."),
        encoding: "utf8",
        env: { ...process.env, AGENT_COLLAB_STATE_DIR: stateRoot },
        timeout: 30_000,
      });

      expect(launched.status, launched.stderr).toBe(0);
      expect(JSON.parse(launched.stdout)).toMatchObject({
        protocol: "agent-collab-review-readiness/v1",
      });
      expect(readFileSync(compiledCli, "utf8")).toContain("STALE_DIST_EXECUTED");
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("does not evaluate the entrypoint when source transformation fails", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-launch-failure-"));
    const marker = join(root, "entrypoint-imported");
    try {
      mkdirSync(join(root, "scripts"));
      mkdirSync(join(root, "src"));
      symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
      copyFileSync(launcher, join(root, "scripts", "agent-collab-launcher.mjs"));
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(
        join(root, "src", "cli.ts"),
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "bad"); const = ;\n`,
      );

      const launched = spawnSync(process.execPath, [join(root, "scripts", "agent-collab-launcher.mjs")], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      });

      expect(launched.status).not.toBe(0);
      expect(launched.stderr).toMatch(/Transform failed|Unexpected/u);
      expect(launched.stderr).not.toContain("flow definition lock");
      expect(() => readFileSync(marker)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes every public entry surface through current-source launchers", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      bin: Record<string, string>;
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(packageJson.bin).toEqual({
      "agent-collab": "scripts/agent-collab-launcher.mjs",
      "agent-collab-eval": "scripts/agent-collab-eval-launcher.mjs",
    });
    expect(packageJson.scripts.start).toBe("node scripts/agent-collab-launcher.mjs");
    expect(packageJson.scripts.eval).toBe("node scripts/agent-collab-eval-launcher.mjs");
    expect(packageJson.scripts["runtime:manifest"]).toBeUndefined();
    expect(packageJson.scripts["runtime:verify"]).toBeUndefined();
    expect(packageJson.dependencies.tsx).toBe("4.22.3");
    expect(readFileSync("systemd/agent-collab.service", "utf8"))
      .toContain("scripts/agent-collab-launcher.mjs review-worker");
    for (const path of [
      "scripts/agent-collab-launcher.mjs",
      "scripts/agent-collab-eval-launcher.mjs",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain('import "tsx/esm"');
      expect(source).toContain("../src/");
      expect(source).not.toContain("dist/");
      expect(source).not.toContain("verifyRuntimeAndDefinitionLock");
    }
  });
});
