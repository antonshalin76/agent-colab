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
      "compatibility-status", "compatibility-runtime", "doctor-v1", "verify-bundle", "restore-v1",
      "migrate-v2", "migrate-v3", "migrate-v4", "extend-review-v3-schema", "map-learn-close",
      "map-evidence-record", "reconcile-run", "mcp", "worker", "index", "probe", "approve",
      "status", "doctor",
    ]) expect(table).toContain(command);
    expect(cli.indexOf("const commandAdmission")).toBeLessThan(cli.indexOf("openStateDatabaseLease("));
    expect(table).toContain('status: "mutating_service"');
    expect(table).toContain('doctor: "mutating_service"');
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
