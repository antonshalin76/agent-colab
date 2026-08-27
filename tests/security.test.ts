import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import { executionAuthorityConsumerKey } from "../src/flow/execution-snapshot.js";
import { ensureStateLayout, resolveStatePath } from "../src/store/state-layout.js";
import { execFileSync } from "node:child_process";

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

  it("distinguishes different staged blobs even when working-tree bytes and status shape match", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-index-fingerprint-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
      const path = join(root, "artifact.txt");
      writeFileSync(path, "base\n");
      execFileSync("git", ["-C", root, "add", "artifact.txt"]);
      execFileSync("git", ["-C", root, "commit", "-qm", "base"]);

      writeFileSync(path, "staged-a\n");
      execFileSync("git", ["-C", root, "add", "artifact.txt"]);
      writeFileSync(path, "same-working-tree\n");
      const first = captureWorkspaceFingerprint(root);

      execFileSync("git", ["-C", root, "reset", "-q", "HEAD", "--", "artifact.txt"]);
      writeFileSync(path, "staged-b\n");
      execFileSync("git", ["-C", root, "add", "artifact.txt"]);
      writeFileSync(path, "same-working-tree\n");
      const second = captureWorkspaceFingerprint(root);

      expect(second.changedFiles).toEqual(first.changedFiles);
      expect(second.fingerprint).not.toBe(first.fingerprint);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("invalidates source identity when the branch ref changes at the same HEAD", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-branch-fingerprint-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
      writeFileSync(join(root, "artifact.txt"), "same bytes\n");
      execFileSync("git", ["-C", root, "add", "artifact.txt"]);
      execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
      execFileSync("git", ["-C", root, "branch", "branch-a"]);
      execFileSync("git", ["-C", root, "branch", "branch-b"]);
      execFileSync("git", ["-C", root, "switch", "-q", "branch-a"]);
      const first = captureWorkspaceFingerprint(root);
      execFileSync("git", ["-C", root, "switch", "-q", "branch-b"]);
      const second = captureWorkspaceFingerprint(root);

      expect(second.headSha).toBe(first.headSha);
      expect(second.diffHash).toBe(first.diffHash);
      expect(second.branchRef).not.toBe(first.branchRef);
      expect(second.fingerprint).not.toBe(first.fingerprint);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("invalidates source identity when the configured upstream tip advances beyond the same fork", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-upstream-fingerprint-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
      writeFileSync(join(root, "artifact.txt"), "base\n");
      execFileSync("git", ["-C", root, "add", "artifact.txt"]);
      execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
      execFileSync("git", ["-C", root, "branch", "base"]);
      execFileSync("git", ["-C", root, "switch", "-qc", "feature"]);
      execFileSync("git", ["-C", root, "branch", "--set-upstream-to=base", "feature"]);
      const first = captureWorkspaceFingerprint(root);

      execFileSync("git", ["-C", root, "switch", "-q", "base"]);
      writeFileSync(join(root, "upstream.txt"), "advanced\n");
      execFileSync("git", ["-C", root, "add", "upstream.txt"]);
      execFileSync("git", ["-C", root, "commit", "-qm", "advance base"]);
      execFileSync("git", ["-C", root, "switch", "-q", "feature"]);
      const second = captureWorkspaceFingerprint(root);

      expect(second.headSha).toBe(first.headSha);
      expect(second.baseSha).toBe(first.baseSha);
      expect(second.upstreamRef).toBe(first.upstreamRef);
      expect(second.upstreamSha).not.toBe(first.upstreamSha);
      expect(second.fingerprint).not.toBe(first.fingerprint);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("binds delegated mutation authority to the exact source fingerprint", () => {
    const target = {
      project: "/repo",
      requester: "codex" as const,
      id: "stage",
      kind: "tdd_coding" as const,
      role: "stage-owner" as const,
      prompt: "implement exact task",
      artifactRef: `artifact:${"a".repeat(64)}`,
      artifactHash: "a".repeat(64),
      artifactBytes: 1,
      changedFiles: 0,
      approvalScope: "workspace-write" as const,
      idempotencyKey: "stage",
      mapLearning: {
        schemaVersion: "map-learning-launch-binding/v1" as const,
        consumer: "codex" as const,
        projectionBase64: "cHJvamVjdGlvbg==",
        digest: "d".repeat(64),
      },
    };
    expect(executionAuthorityConsumerKey("workflow", { ...target, sourceFingerprint: "b".repeat(64) }))
      .not.toBe(executionAuthorityConsumerKey("workflow", { ...target, sourceFingerprint: "c".repeat(64) }));
  });
});
