import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertProductionRuntimeReleased } from "../src/runtime/production-release-gate.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production runtime quarantine", () => {
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-release-gate-"));
    roots.push(root);
    return root;
  };

  it("has no caller-controlled positive path", () => {
    expect(() => assertProductionRuntimeReleased()).toThrow(/no certified graph release is installed/);
  });

  it.each(["mcp", "worker"])("blocks %s before creating state even with a forged marker", (command) => {
    const root = fixture();
    const stateRoot = join(root, "state");
    const markerPath = join(root, "forged-release.json");
    writeFileSync(markerPath, `${JSON.stringify({
      schemaVersion: "agent-collab-production-release/v1",
      releaseCommit: "a".repeat(40),
      graphFlowDefault: true,
      legacyDelegateDisabled: true,
      createdAt: "2026-09-01T00:00:00Z",
    })}\n`);
    const launched = spawnSync(process.execPath, ["scripts/agent-collab-launcher.mjs", command], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_COLLAB_STATE_DIR: stateRoot,
        AGENT_COLLAB_RELEASE_MARKER: markerPath,
      },
      timeout: 30_000,
    });
    expect(launched.status).not.toBe(0);
    expect(`${launched.stdout}\n${launched.stderr}`).toMatch(/permanently quarantined/);
    expect(existsSync(stateRoot)).toBe(false);
  });

  it("keeps read-only status fail-closed and side-effect free without existing state", () => {
    const root = fixture();
    const stateRoot = join(root, "state");
    const launched = spawnSync(process.execPath, ["scripts/agent-collab-launcher.mjs", "status"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, AGENT_COLLAB_STATE_DIR: stateRoot },
      timeout: 30_000,
    });
    expect(launched.status).not.toBe(0);
    expect(existsSync(stateRoot)).toBe(false);
  });
});
