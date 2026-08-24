import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import { ensureStateLayout, resolveStatePath } from "../src/store/state-layout.js";

describe("local state security", () => {
  it("creates private files and no listener", () => {
    const parent = mkdtempSync(join(tmpdir(), "agent-collab-security-"));
    try { const root = join(parent, "state"); const layout = ensureStateLayout(root); expect(lstatSync(root).mode & 0o777).toBe(0o700); expect(lstatSync(layout.database).mode & 0o777).toBe(0o600); expect(layout.socket).toBeUndefined(); }
    finally { rmSync(parent, { recursive: true, force: true }); }
  });
  it("rejects traversal and symlink escape", () => {
    const parent = mkdtempSync(join(tmpdir(), "agent-collab-path-"));
    try { const root = join(parent, "state"); ensureStateLayout(root); expect(() => resolveStatePath(root, "../outside")).toThrow(/outside/i); symlinkSync(parent, join(root, "link")); expect(() => resolveStatePath(root, "link/secret")).toThrow(/symlink/i); }
    finally { rmSync(parent, { recursive: true, force: true }); }
  });
  it("detects content drift in a non-git workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-fingerprint-"));
    try {
      const path = join(root, "artifact.txt"); writeFileSync(path, "v1");
      const before = captureWorkspaceFingerprint(root); writeFileSync(path, "v2");
      expect(captureWorkspaceFingerprint(root).fingerprint).not.toBe(before.fingerprint);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
