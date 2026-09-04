import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
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
  it("rejects non-default XDG unit paths instead of staging into a different precedence tree", () => {
    const root = temporaryRoot();
    const previousConfig = process.env.XDG_CONFIG_HOME;
    const previousData = process.env.XDG_DATA_HOME;
    process.env.XDG_CONFIG_HOME = join(root, "custom-config");
    process.env.XDG_DATA_HOME = join(root, "custom-data");
    try {
      expect(() => stageReviewedWorkerService({
        repositoryRoot: resolve("."),
        homeDirectory: join(root, "home"),
        backupDirectory: join(root, "backup"),
        systemctl: () => ({ status: 0, stdout: "", stderr: "" }),
      })).toThrow(/default HOME-scoped XDG/i);
    } finally {
      if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfig;
      if (previousData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousData;
    }
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
    const configDirectory = join(home, ".config/systemd/user");
    const dataDirectory = join(home, ".local/share/systemd/user");
    const legacyPath = join(configDirectory, "agent-collab.service");
    const legacyDropIns = `${legacyPath}.d`;
    const reviewedMaskPath = join(configDirectory, "agent-collab-reviewed.service");
    const reviewedPath = join(dataDirectory, "agent-collab-reviewed.service");
    const backup = join(root, "backup");
    mkdirSync(legacyDropIns, { recursive: true });
    symlinkSync("/dev/null", legacyPath);
    writeFileSync(reviewedMaskPath, "[Service]\nExecStart=/repo/dist/cli.js worker\n");
    mkdirSync(`${reviewedMaskPath}.d`, { recursive: true });
    mkdirSync(`${reviewedPath}.d`, { recursive: true });
    writeFileSync(join(`${reviewedMaskPath}.d`, "config-override.conf"), "[Service]\nEnvironment=STALE=1\n");
    writeFileSync(join(`${reviewedPath}.d`, "data-override.conf"), "[Service]\nEnvironment=STALE=2\n");
    writeFileSync(join(legacyDropIns, "override.conf"), "[Service]\nExecStart=/repo/dist/cli.js worker\n");
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
        const reviewedMasked = existsSync(reviewedMaskPath) && lstatSync(reviewedMaskPath).isSymbolicLink();
        return { status: reviewedEnabled ? 0 : 1,
          stdout: `${reviewedMasked ? "masked" : reviewedEnabled ? "enabled" : "disabled"}\n`, stderr: "" };
      }
      if (args[0] === "disable") { reviewedEnabled = false; reviewedActive = false; }
      if (args[0] === "unmask" && !args.includes("--runtime") && existsSync(reviewedMaskPath)) {
        unlinkSync(reviewedMaskPath);
      }
      if (args[0] === "enable") { reviewedEnabled = true; reviewedActive = args.includes("--now"); }
      if (args[0] === "show") {
        const legacy = args[1] === "agent-collab.service";
        const reviewedMasked = existsSync(reviewedMaskPath) && lstatSync(reviewedMaskPath).isSymbolicLink();
        return {
          status: 0,
          stdout: [
            `FragmentPath=${legacy ? legacyPath : reviewedMasked ? reviewedMaskPath : reviewedPath}`,
            `ExecStart=${legacy ? "" : `{ path=/usr/bin/env ; argv[]=/usr/bin/env node ${resolve(".")}/scripts/agent-collab-launcher.mjs review-worker ; }`}`,
            `DropInPaths=${legacy ? join(legacyDropIns, "override.conf") : ""}`,
            `LoadState=${legacy || reviewedMasked ? "masked" : "loaded"}`,
            `ActiveState=${reviewedActive ? "active" : "inactive"}`,
            `UnitFileState=${legacy || reviewedMasked ? "masked" : reviewedEnabled ? "enabled" : "disabled"}`,
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
    expect(readlinkSync(reviewedMaskPath)).toBe("/dev/null");
    expect(readFileSync(join(backup, "previous-config-agent-collab-reviewed.service"), "utf8"))
      .toContain("dist/cli.js worker");
    expect(existsSync(`${reviewedMaskPath}.d`)).toBe(false);
    expect(existsSync(`${reviewedPath}.d`)).toBe(false);
    for (const layer of ["config", "data"] as const) {
      expect(existsSync(join(backup, `snapshot-${layer}-agent-collab-reviewed.service.d`))).toBe(true);
      expect(existsSync(join(backup, `removed-${layer}-agent-collab-reviewed.service.d`))).toBe(true);
    }
    expect(statSync(join(configDirectory, "agent-collab-reviewed.cutover.lock")).mode & 0o777).toBe(0o600);
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
    expect(calls).toContain("unmask --runtime agent-collab-reviewed.service");
    expect(calls).toContain("unmask agent-collab-reviewed.service");
    expect(calls).toContain("enable --now agent-collab-reviewed.service");
  });

  it("restores the persistent mask when post-unmask activation verification fails", () => {
    const root = temporaryRoot();
    const home = join(root, "home");
    const configDirectory = join(home, ".config/systemd/user");
    const dataDirectory = join(home, ".local/share/systemd/user");
    const legacyPath = join(configDirectory, "agent-collab.service");
    const maskPath = join(configDirectory, "agent-collab-reviewed.service");
    const unitPath = join(dataDirectory, "agent-collab-reviewed.service");
    mkdirSync(configDirectory, { recursive: true });
    mkdirSync(dataDirectory, { recursive: true });
    symlinkSync("/dev/null", legacyPath);
    symlinkSync("/dev/null", maskPath);
    writeFileSync(unitPath, readFileSync("systemd/agent-collab.service"));
    let enabled = false;
    const calls: string[] = [];
    const systemctl: SystemctlRunner = (args) => {
      calls.push(args.join(" "));
      if (args[0] === "is-active") {
        return { status: 3, stdout: "inactive\n", stderr: "" };
      }
      if (args[0] === "is-enabled") {
        const masked = existsSync(maskPath) && lstatSync(maskPath).isSymbolicLink();
        return { status: enabled ? 0 : 1, stdout: `${masked ? "masked" : enabled ? "enabled" : "disabled"}\n`, stderr: "" };
      }
      if (args[0] === "disable") enabled = false;
      if (args[0] === "unmask" && !args.includes("--runtime") && existsSync(maskPath)) unlinkSync(maskPath);
      if (args[0] === "show") {
        const legacy = args[1] === "agent-collab.service";
        const masked = existsSync(maskPath) && lstatSync(maskPath).isSymbolicLink();
        return {
          status: 0,
          stdout: [
            `FragmentPath=${legacy ? legacyPath : masked ? maskPath : unitPath}`,
            `ExecStart=${legacy || masked ? "" : "/repo/dist/cli.js worker"}`,
            "DropInPaths=",
            `LoadState=${legacy || masked ? "masked" : "loaded"}`,
            "ActiveState=inactive",
            `UnitFileState=${legacy || masked ? "masked" : enabled ? "enabled" : "disabled"}`,
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
    expect(readlinkSync(maskPath)).toBe("/dev/null");
    expect(calls).toContain("disable --now agent-collab-reviewed.service");
    expect(calls).toContain("unmask --runtime agent-collab-reviewed.service");
    expect(calls.slice(-3)).toEqual([
      "is-active agent-collab-reviewed.service",
      "is-enabled agent-collab-reviewed.service",
      "show agent-collab-reviewed.service --property=FragmentPath --property=ExecStart --property=DropInPaths --property=LoadState --property=ActiveState --property=UnitFileState",
    ]);
    expect(readFileSync(legacyPath).length).toBe(0);
  });

  it("reports incomplete rollback when the manager remains active behind a filesystem mask", () => {
    const root = temporaryRoot();
    const home = join(root, "home");
    const configDirectory = join(home, ".config/systemd/user");
    const dataDirectory = join(home, ".local/share/systemd/user");
    const legacyPath = join(configDirectory, "agent-collab.service");
    const maskPath = join(configDirectory, "agent-collab-reviewed.service");
    const unitPath = join(dataDirectory, "agent-collab-reviewed.service");
    mkdirSync(configDirectory, { recursive: true });
    mkdirSync(dataDirectory, { recursive: true });
    symlinkSync("/dev/null", legacyPath);
    symlinkSync("/dev/null", maskPath);
    writeFileSync(unitPath, readFileSync("systemd/agent-collab.service"));
    let rollbackStarted = false;
    const systemctl: SystemctlRunner = (args) => {
      const legacy = args[1] === "agent-collab.service";
      const masked = existsSync(maskPath) && lstatSync(maskPath).isSymbolicLink();
      if (args[0] === "disable") {
        rollbackStarted = true;
        return { status: 1, stdout: "", stderr: "stop failed" };
      }
      if (args[0] === "unmask" && !args.includes("--runtime") && existsSync(maskPath)) unlinkSync(maskPath);
      if (args[0] === "is-active") {
        const active = !legacy && rollbackStarted;
        return { status: active ? 0 : 3, stdout: `${active ? "active" : "inactive"}\n`, stderr: "" };
      }
      if (args[0] === "is-enabled") {
        return { status: 1, stdout: `${masked ? "masked" : "disabled"}\n`, stderr: "" };
      }
      if (args[0] === "show") {
        return { status: 0, stdout: [
          `FragmentPath=${legacy ? legacyPath : masked ? maskPath : unitPath}`,
          `ExecStart=${legacy || masked ? "" : "/repo/dist/cli.js worker"}`,
          "DropInPaths=",
          `LoadState=${legacy || masked ? "masked" : "loaded"}`,
          `ActiveState=${!legacy && rollbackStarted ? "active" : "inactive"}`,
          `UnitFileState=${legacy || masked ? "masked" : "disabled"}`,
        ].join("\n") + "\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    let failure: unknown;
    try {
      activateReviewedWorkerService({ repositoryRoot: resolve("."), homeDirectory: home, systemctl });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(String(failure)).toMatch(/persistent activation mask could not be fully restored/i);
    expect((failure as AggregateError).errors.map(String).join("\n")).toMatch(/must be inactive/i);
    expect(readlinkSync(maskPath)).toBe("/dev/null");
  });

  it("compensates the post-disable pre-mask fault boundary with a verified persistent mask", () => {
    const root = temporaryRoot();
    const home = join(root, "home");
    const configDirectory = join(home, ".config/systemd/user");
    const legacyPath = join(configDirectory, "agent-collab.service");
    const maskPath = join(configDirectory, "agent-collab-reviewed.service");
    mkdirSync(configDirectory, { recursive: true });
    symlinkSync("/dev/null", legacyPath);
    const systemctl: SystemctlRunner = (args) => {
      const legacy = args[1] === "agent-collab.service";
      const masked = existsSync(maskPath) && lstatSync(maskPath).isSymbolicLink();
      if (args[0] === "is-active") return { status: 3, stdout: "inactive\n", stderr: "" };
      if (args[0] === "is-enabled") {
        return { status: 1, stdout: `${masked ? "masked" : "disabled"}\n`, stderr: "" };
      }
      if (args[0] === "show") return { status: 0, stdout: [
        `FragmentPath=${legacy ? legacyPath : masked ? maskPath : ""}`,
        "ExecStart=",
        "DropInPaths=",
        `LoadState=${legacy || masked ? "masked" : "not-found"}`,
        "ActiveState=inactive",
        `UnitFileState=${legacy || masked ? "masked" : ""}`,
      ].join("\n") + "\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    expect(() => stageReviewedWorkerService({
      repositoryRoot: resolve("."),
      homeDirectory: home,
      backupDirectory: join(root, "backup"),
      systemctl,
      faultInjector: (point) => {
        if (point === "after_reviewed_disabled") throw new Error("injected post-disable fault");
      },
    })).toThrow(/injected post-disable fault/i);
    expect(readlinkSync(maskPath)).toBe("/dev/null");
  });

  it("persistently masks the reviewed unit when staging fails before backup creation", () => {
    const root = temporaryRoot();
    const home = join(root, "home");
    const unitDirectory = join(home, ".config/systemd/user");
    const legacyPath = join(unitDirectory, "agent-collab.service");
    const maskPath = join(unitDirectory, "agent-collab-reviewed.service");
    mkdirSync(unitDirectory, { recursive: true });
    symlinkSync("/dev/null", legacyPath);
    const calls: string[] = [];
    const systemctl: SystemctlRunner = (args) => {
      calls.push(args.join(" "));
      if (args[0] === "is-active") return { status: 3, stdout: "inactive\n", stderr: "" };
      if (args[0] === "is-enabled") {
        const masked = existsSync(maskPath) && lstatSync(maskPath).isSymbolicLink();
        return { status: 1, stdout: `${masked ? "masked" : "disabled"}\n`, stderr: "" };
      }
      if (args[0] === "show") {
        return { status: 0, stdout: [
          `FragmentPath=${legacyPath}`,
          "ExecStart=",
          "DropInPaths=",
          "LoadState=masked",
          "ActiveState=inactive",
          "UnitFileState=masked",
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
    expect(readlinkSync(maskPath)).toBe("/dev/null");
    expect(calls).toContain("disable --now agent-collab-reviewed.service");
    expect(calls).toContain("unmask --runtime agent-collab-reviewed.service");
    expect(calls.slice(-3)).toEqual([
      "is-active agent-collab-reviewed.service",
      "is-enabled agent-collab-reviewed.service",
      "show agent-collab-reviewed.service --property=FragmentPath --property=ExecStart --property=DropInPaths --property=LoadState --property=ActiveState --property=UnitFileState",
    ]);
    expect(readFileSync(legacyPath).length).toBe(0);
  });
});
