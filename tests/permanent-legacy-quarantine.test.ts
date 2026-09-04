import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { CollaborationRunStore } from "../src/store/collaboration-run-store.js";
import {
  activateReviewedWorkerService,
  stageReviewedWorkerService,
  type SystemctlRunner,
} from "../src/runtime/review-service-unit.js";
import { systemdUserEnvironment } from "../src/runtime/systemd-user.js";

const dispatcher = resolve("src/migration/stable-dispatcher.ts");
const roots: string[] = [];

const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-permanent-quarantine-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("permanent legacy runtime quarantine", () => {
  it("derives a user-manager DBus environment when non-login callers provide none", () => {
    expect(systemdUserEnvironment({ PATH: "/usr/bin" }, 1000)).toMatchObject({
      PATH: "/usr/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
    expect(systemdUserEnvironment({
      XDG_RUNTIME_DIR: "/custom/runtime",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus",
    }, 1000)).toMatchObject({
      XDG_RUNTIME_DIR: "/custom/runtime",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus",
    });
  });
  it.each([
    "worker",
    "mcp",
    "review-mcp",
    "mcp-verify-session",
    "start-normal",
    "prove-normal",
    "verify-unit",
  ])("rejects dispatcher route %s before an attacker-selected runtime executes", (command) => {
    const root = temporaryRoot();
    const marker = join(root, "runtime-executed");
    const runtime = join(root, "old-runtime");
    writeFileSync(runtime, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`, { mode: 0o700 });

    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", dispatcher, command],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          AGENT_COLLAB_ACTIVE_RUNTIME: runtime,
          AGENT_COLLAB_RESTORE_JOURNAL: join(root, "missing-journal"),
          AGENT_COLLAB_RESTORE_LOCK: join(root, "unused-lock"),
        },
        input: command.includes("mcp")
          ? `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`
          : undefined,
        timeout: 2_000,
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/permanently quarantined/i);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, "unused-lock"))).toBe(false);
  });

  it("serves permitted status without executing an attacker-selected runtime", () => {
    const root = temporaryRoot();
    const marker = join(root, "runtime-executed");
    const runtime = join(root, "old-runtime");
    const journal = join(root, "journal.json");
    const lock = join(root, "restore.lock");
    writeFileSync(runtime, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`, { mode: 0o700 });
    writeFileSync(journal, `${JSON.stringify({
      action: "verify",
      nonce: "status-nonce",
      phase: "verifying",
      targetVersion: "v1",
      permits: {
        is_active: { nonce: "status-nonce", token: "status-token", consumed: false },
      },
    })}\n`);

    const result = spawnSync(process.execPath, [
      "--experimental-strip-types",
      dispatcher,
      "status",
      "--action",
      "is_active",
      "--nonce",
      "status-nonce",
      "--permit",
      "status-token",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_COLLAB_ACTIVE_RUNTIME: runtime,
        AGENT_COLLAB_RESTORE_JOURNAL: journal,
        AGENT_COLLAB_RESTORE_LOCK: lock,
        TARGET_VERSION: "v1",
      },
      timeout: 2_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ protocol: "agent-collab/v1", targetVersion: "v1" });
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects direct linear workflow creation before state or outbox mutation", () => {
    const root = temporaryRoot();
    const databasePath = join(root, "collaboration.db");
    initializeCurrentExecutionSchema(databasePath);
    const store = new CollaborationRunStore(databasePath);
    try {
      expect(() => store.createStartedIfAbsent(
        "forbidden-linear-workflow",
        {} as never,
        {} as never,
        1,
      )).toThrow(/linear delegation is permanently disabled/i);
    } finally {
      store.close();
    }

    const database = new Database(databasePath, { readonly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) FROM collaboration_runs").pluck().get()).toBe(0);
      expect(database.prepare("SELECT COUNT(*) FROM collaboration_dispatch_outbox").pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("publishes only review-only production entrypoints", () => {
    const unit = readFileSync("systemd/agent-collab.service", "utf8");
    const english = readFileSync("README.md", "utf8");
    const russian = readFileSync("README.ru.md", "utf8");

    expect(unit).toContain("scripts/agent-collab-launcher.mjs review-worker");
    expect(unit).not.toMatch(/agent-collab-launcher\.mjs (?:worker|mcp)(?:\s|$)/u);
    for (const documentation of [english, russian]) {
      expect(documentation).toContain("agent-collab-launcher.mjs review-mcp-codex");
      expect(documentation).toContain("agent-collab-launcher.mjs review-mcp-status");
      expect(documentation).not.toMatch(/agent-collab-launcher\.mjs review-mcp(?:\s|$)/u);
      expect(documentation).toContain("npm start -- review-worker");
      expect(documentation).not.toMatch(/agent-collab-launcher\.mjs mcp(?:\s|$)/u);
      expect(documentation).not.toMatch(/npm start -- worker(?:\s|$)/u);
    }
  });

  it("keeps the legacy unit persistently masked while staging and activating a distinct reviewed unit", () => {
    const root = temporaryRoot();
    const home = join(root, "home");
    const unitDirectory = join(home, ".config/systemd/user");
    const legacyPath = join(unitDirectory, "agent-collab.service");
    const legacyDropIns = `${legacyPath}.d`;
    const reviewedPath = join(unitDirectory, "agent-collab-reviewed.service");
    const backup = join(root, "backup");
    mkdirSync(legacyDropIns, { recursive: true });
    symlinkSync("/dev/null", legacyPath);
    writeFileSync(join(legacyDropIns, "override.conf"), "[Service]\nExecStart=/repo/dist/cli.js worker\n");
    let reviewedMasked = false;
    let reviewedActive = false;
    let reviewedEnabled = false;
    const calls: string[] = [];
    const systemctl: SystemctlRunner = (args) => {
      calls.push(args.join(" "));
      if (args[0] === "is-active") {
        const active = args[1] === "agent-collab-reviewed.service" && reviewedActive;
        return { status: active ? 0 : 3, stdout: `${active ? "active" : "inactive"}\n`, stderr: "" };
      }
      if (args[0] === "is-enabled") {
        return { status: reviewedEnabled ? 0 : 1,
          stdout: `${reviewedMasked ? "masked" : reviewedEnabled ? "enabled" : "disabled"}\n`, stderr: "" };
      }
      if (args[0] === "disable") { reviewedEnabled = false; reviewedActive = false; }
      if (args[0] === "mask") reviewedMasked = true;
      if (args[0] === "unmask") reviewedMasked = false;
      if (args[0] === "enable") { reviewedEnabled = true; reviewedActive = args.includes("--now"); }
      if (args[0] === "show") {
        const legacy = args[1] === "agent-collab.service";
        return {
          status: 0,
          stdout: [
            `FragmentPath=${legacy ? legacyPath : reviewedPath}`,
            `ExecStart=${legacy ? "" : `{ path=/usr/bin/env ; argv[]=/usr/bin/env node ${resolve(".")}/scripts/agent-collab-launcher.mjs review-worker ; }`}`,
            `DropInPaths=${legacy ? join(legacyDropIns, "override.conf") : ""}`,
            `LoadState=${legacy || reviewedMasked ? "masked" : "loaded"}`,
            `ActiveState=${reviewedActive ? "active" : "inactive"}`,
          ].join("\n") + "\n",
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    const staged = stageReviewedWorkerService({
      repositoryRoot: resolve("."),
      homeDirectory: home,
      backupDirectory: backup,
      systemctl,
    });
    expect(staged).toMatchObject({ status: "staged_masked", fragmentPath: reviewedPath, loadState: "masked" });
    expect(readFileSync(reviewedPath)).toEqual(readFileSync("systemd/agent-collab.service"));
    expect(readFileSync(legacyPath).length).toBe(0);
    expect(readFileSync(join(legacyDropIns, "override.conf"), "utf8")).toContain("dist/cli.js worker");
    expect(calls).not.toContain("unmask agent-collab.service");

    const activated = activateReviewedWorkerService({
      repositoryRoot: resolve("."),
      homeDirectory: home,
      systemctl,
    });
    expect(activated).toMatchObject({ status: "active", fragmentPath: reviewedPath, loadState: "loaded" });
    expect(reviewedEnabled).toBe(true);
    expect(reviewedActive).toBe(true);
    expect(calls).toContain("daemon-reload");
    expect(calls).toContain("mask --runtime agent-collab-reviewed.service");
    expect(calls).toContain("unmask --runtime agent-collab-reviewed.service");
    expect(calls).toContain("enable --now agent-collab-reviewed.service");
  });

  it("restores the runtime mask when post-unmask activation verification fails", () => {
    const root = temporaryRoot();
    const home = join(root, "home");
    const unitDirectory = join(home, ".config/systemd/user");
    const legacyPath = join(unitDirectory, "agent-collab.service");
    const unitPath = join(unitDirectory, "agent-collab-reviewed.service");
    mkdirSync(unitDirectory, { recursive: true });
    symlinkSync("/dev/null", legacyPath);
    writeFileSync(unitPath, readFileSync("systemd/agent-collab.service"));
    let masked = true;
    let enabled = false;
    const calls: string[] = [];
    const systemctl: SystemctlRunner = (args) => {
      calls.push(args.join(" "));
      if (args[0] === "is-active") {
        return { status: 3, stdout: "inactive\n", stderr: "" };
      }
      if (args[0] === "is-enabled") {
        return { status: enabled ? 0 : 1, stdout: `${masked ? "masked" : enabled ? "enabled" : "disabled"}\n`, stderr: "" };
      }
      if (args[0] === "disable") enabled = false;
      if (args[0] === "unmask") masked = false;
      if (args[0] === "mask") masked = true;
      if (args[0] === "show") {
        const legacy = args[1] === "agent-collab.service";
        return {
          status: 0,
          stdout: [
            `FragmentPath=${legacy ? legacyPath : unitPath}`,
            `ExecStart=${legacy || masked ? "" : "/repo/dist/cli.js worker"}`,
            "DropInPaths=",
            `LoadState=${legacy || masked ? "masked" : "loaded"}`,
            "ActiveState=inactive",
          ].join("\n") + "\n",
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    expect(() => activateReviewedWorkerService({
      repositoryRoot: resolve("."),
      homeDirectory: home,
      systemctl,
    })).toThrow(/exact review-only source launcher/i);
    expect(masked).toBe(true);
    expect(calls.slice(-3)).toEqual([
      "disable --now agent-collab-reviewed.service",
      "mask --runtime agent-collab-reviewed.service",
      "daemon-reload",
    ]);
    expect(readFileSync(legacyPath).length).toBe(0);
  });

  it("runtime-masks the reviewed unit when staging fails immediately after disable", () => {
    const root = temporaryRoot();
    const home = join(root, "home");
    const unitDirectory = join(home, ".config/systemd/user");
    const legacyPath = join(unitDirectory, "agent-collab.service");
    mkdirSync(unitDirectory, { recursive: true });
    symlinkSync("/dev/null", legacyPath);
    let masked = false;
    const calls: string[] = [];
    const systemctl: SystemctlRunner = (args) => {
      calls.push(args.join(" "));
      if (args[0] === "is-active") return { status: 3, stdout: "inactive\n", stderr: "" };
      if (args[0] === "is-enabled") {
        return { status: 1, stdout: `${masked ? "masked" : "disabled"}\n`, stderr: "" };
      }
      if (args[0] === "mask") masked = true;
      if (args[0] === "show") {
        return { status: 0, stdout: [
          `FragmentPath=${legacyPath}`,
          "ExecStart=",
          "DropInPaths=",
          "LoadState=masked",
          "ActiveState=inactive",
        ].join("\n") + "\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    expect(() => stageReviewedWorkerService({
      repositoryRoot: resolve("."),
      homeDirectory: home,
      backupDirectory: root,
      systemctl,
    })).toThrow(/backup directory.*nonexistent/i);
    expect(masked).toBe(true);
    expect(calls.slice(-3)).toEqual([
      "disable --now agent-collab-reviewed.service",
      "mask --runtime agent-collab-reviewed.service",
      "daemon-reload",
    ]);
    expect(readFileSync(legacyPath).length).toBe(0);
  });
});
