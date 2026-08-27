import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalLedger } from "../src/security/approval-ledger.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-approval-"));
  roots.push(root);
  const path = join(root, "approvals.db");
  initializeCurrentExecutionSchema(path);
  return path;
}

describe("approval ledger", () => {
  it("consumes a single-use approval only for the exact reference, project, and scope", () => {
    const ledger = new ApprovalLedger(databasePath());
    ledger.issue({
      reference: "approval-42",
      project: "/repo/a",
      scope: "external",
      expiresAt: 2_000,
    });

    expect(
      ledger.validateAndConsume({
        reference: "approval-42",
        project: "/repo/b",
        scope: "external",
        now: 1_000,
      }),
    ).toEqual({ allowed: false, reason: "project_mismatch" });
    expect(
      ledger.validateAndConsume({
        reference: "approval-42",
        project: "/repo/a",
        scope: "workspace-write",
        now: 1_000,
      }),
    ).toEqual({ allowed: false, reason: "scope_mismatch" });
    expect(
      ledger.validateAndConsume({
        reference: "wrong-reference",
        project: "/repo/a",
        scope: "external",
        now: 1_000,
      }),
    ).toEqual({ allowed: false, reason: "not_found" });

    expect(
      ledger.validateAndConsume({
        reference: "approval-42",
        project: "/repo/a",
        scope: "external",
        now: 1_000,
      }),
    ).toEqual({ allowed: true, remainingUses: 0 });
    expect(
      ledger.validateAndConsume({
        reference: "approval-42",
        project: "/repo/a",
        scope: "external",
        now: 1_001,
      }),
    ).toEqual({ allowed: false, reason: "exhausted" });
    ledger.close();
  });

  it("enforces expiry and persists bounded multi-use consumption across connections", () => {
    const path = databasePath();
    const issuer = new ApprovalLedger(path);
    issuer.issue({
      reference: "approval-multi",
      project: "/repo",
      scope: "workspace-write",
      expiresAt: 5_000,
      maxUses: 2,
    });
    issuer.issue({
      reference: "approval-expired",
      project: "/repo",
      scope: "external",
      expiresAt: 1_000,
    });
    issuer.close();

    const first = new ApprovalLedger(path);
    const second = new ApprovalLedger(path);
    expect(
      first.validateAndConsume({
        reference: "approval-expired",
        project: "/repo",
        scope: "external",
        now: 1_000,
      }),
    ).toEqual({ allowed: false, reason: "expired" });
    expect(
      first.validateAndConsume({
        reference: "approval-multi",
        project: "/repo",
        scope: "workspace-write",
        now: 2_000,
      }),
    ).toEqual({ allowed: true, remainingUses: 1 });
    expect(
      second.validateAndConsume({
        reference: "approval-multi",
        project: "/repo",
        scope: "workspace-write",
        now: 2_001,
      }),
    ).toEqual({ allowed: true, remainingUses: 0 });
    expect(
      first.validateAndConsume({
        reference: "approval-multi",
        project: "/repo",
        scope: "workspace-write",
        now: 2_002,
      }),
    ).toEqual({ allowed: false, reason: "exhausted" });
    first.close();
    second.close();
  });

  it("consumes authority once for concurrent retries of the same canonical workflow", () => {
    const path = databasePath();
    const first = new ApprovalLedger(path); const second = new ApprovalLedger(path);
    first.issue({ reference: "approval-once", project: "/repo", scope: "workspace-write", expiresAt: 5_000 });
    const request = { reference: "approval-once", project: "/repo", scope: "workspace-write" as const,
      consumerKey: "project-hash:workflow-42", now: 1_000 };
    expect(first.validateAndConsume(request)).toEqual({ allowed: true, remainingUses: 0 });
    expect(second.validateAndConsume({ ...request, now: 1_001 })).toEqual({ allowed: true, remainingUses: 0 });
    expect(() => second.validateAndConsume({ ...request, project: "/other", now: 1_002 }))
      .toThrow(/consumer key conflicts/i);
    first.close(); second.close();
  });

  it("rejects invalid grants instead of silently resetting authority", () => {
    const path = databasePath();
    const ledger = new ApprovalLedger(path);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(() =>
      ledger.issue({ reference: "", project: "/repo", scope: "external", expiresAt: 2_000 }),
    ).toThrow(/reference/i);
    expect(() =>
      ledger.issue({
        reference: "approval-invalid",
        project: "/repo",
        scope: "external",
        expiresAt: 2_000,
        maxUses: 0,
      }),
    ).toThrow(/maxUses/i);

    ledger.issue({ reference: "approval-unique", project: "/repo", scope: "external", expiresAt: 2_000 });
    expect(() =>
      ledger.issue({ reference: "approval-unique", project: "/repo", scope: "external", expiresAt: 9_000 }),
    ).toThrow(/already exists/i);
    ledger.close();
  });
});
