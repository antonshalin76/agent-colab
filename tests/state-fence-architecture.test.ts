import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("state fence dependency architecture", () => {
  it("keeps guard and flock policy out of CLI and stores", () => {
    const cli = source("src/cli.ts");
    const graph = source("src/store/graph-flow-store.ts");
    const fence = source("src/store/state-database-fence.ts");
    expect(cli).not.toContain("recordStateV4GuardEventBeforeEffect");
    const restore = cli.slice(cli.indexOf('if (command === "restore-v1")'),
      cli.indexOf('if (command === "migrate-v2")'));
    expect(cli.replace(restore, "")).not.toMatch(/new Database\(layout\.database/u);
    expect(graph).not.toContain("migration/coordinator");
    expect(graph).not.toContain("state-layout");
    expect(graph).not.toContain("StateV4RestoreGuard");
    expect(fence).not.toContain("migration/coordinator");
  });

  it("classifies every public CLI command before the first state open", () => {
    const cli = source("src/cli.ts");
    const table = cli.slice(cli.indexOf("const CLI_STATE_ADMISSION"), cli.indexOf("const stateRoot"));
    for (const command of [
      "compatibility-status", "doctor-v1", "verify-bundle", "restore-v1", "migrate-v2", "migrate-v3",
      "reviewed-source-promote", "reviewed-source-adopt", "review-service-stage", "review-service-activate",
      "stg04-close-preflight", "stg04-close-status", "stg04-close-prepare",
      "review-mcp-status", "review-initialize", "review-mcp-codex",
      "review-worker", "review-readiness", "review-skills-link", "map-learn-close", "map-evidence-record",
      "reconcile-run", "probe", "status", "doctor",
    ]) expect(table).toContain(command);
    const beforeStateRoot = cli.slice(cli.indexOf("const command"), cli.indexOf("const stateRoot"));
    for (const command of [
      "worker", "mcp", "review-mcp", "mcp-verify-session", "start-normal", "prove-normal", "verify-unit",
      "compatibility-runtime", "migrate-v4", "extend-review-v3-schema",
    ]) {
      expect(beforeStateRoot).toContain(command);
      expect(table).not.toContain(`\"${command}\":`);
    }
    expect(cli.indexOf("PERMANENTLY_QUARANTINED_COMMANDS.has(command)"))
      .toBeLessThan(cli.indexOf("const stateRoot"));
    expect(cli.indexOf("const commandAdmission")).toBeLessThan(cli.indexOf("openStateDatabaseLease("));
    expect(table).toContain('status: "offline_observation"');
    expect(table).toContain('doctor: "no_state"');
    expect(table).toContain('"review-service-stage": "no_state"');
    expect(table).toContain('"review-service-activate": "offline_observation"');
    expect(table).toContain('"review-mcp-status": "offline_observation"');
    expect(table).toContain('"review-mcp-codex": "mutating_service"');
    const restore = cli.slice(cli.indexOf('if (command === "restore-v1")'),
      cli.indexOf('if (command === "migrate-v2")'));
    expect(restore.indexOf("doctorV1Databases(")).toBeLessThan(restore.indexOf("rootLease.release();"));
  });

  it("uses typed lease ownership plus an unforgeable live capability brand", () => {
    const fence = source("src/store/state-database-fence.ts");
    expect(fence).toContain("class IssuedStateDatabaseLease");
    expect(fence).toContain("class IssuedStateDatabaseBorrow");
    expect(fence).not.toContain("export class StateDatabaseLease");
    expect(fence).not.toContain("export class StateDatabaseBorrow");
    expect(fence).toContain("#state");
    expect(fence).toContain("issuedStateDatabaseAccesses = new WeakSet");
    expect(fence).toContain("issuedStateDatabaseAccesses.has(input)");
    expect(fence).not.toContain("assertFencedStateDatabaseHandle");
    expect(fence).toContain("raw file-backed SQLite handles are unsupported; spoofed handles are unsupported");
  });
});
