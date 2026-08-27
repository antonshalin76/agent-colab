import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  MapLearningCandidate,
  MapLearningCloseInput,
  MapLearningRuntimeAuthority,
} from "../src/flow/map-learning.js";
import { MapLearningAdministration } from "../src/flow/map-learning.js";
import { prepareLearningFixture } from "./map-learning-fixture.js";

const MAP_VERSION = "3.28.1";
const MAP_SOURCE_REVISION = "1ba52a77b8228a509f3ef08c4fb1f89465699a73";
const MAP_SOURCE_ARCHIVE_SHA256 = "b5a391a4f892334655a9d5dc0a405020dfb9284dbd9c9ee63b8be78a818bf990";
const MAP_INSTALL_MANIFEST_SHA256 = "392a90596d0aaff3a6cfc2e40bed3dbbcc0b2da41512b1827fa1b5cb4de536e0";
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLED_MAP_LOCK_PATH = join(PROJECT_ROOT, ".map/mapify.lock.json");
const INSTALLED_MAP_CONFIG_PATH = join(PROJECT_ROOT, ".map/config.yaml");
const CONCURRENT_CLOSE_ENV = "AGENT_COLLAB_MAP_CLOSE_WORKER";
const CRASH_CLOSE_ENV = "AGENT_COLLAB_MAP_CRASH_CLOSE_WORKER";
const isConcurrentCloseWorker = process.env[CONCURRENT_CLOSE_ENV] !== undefined;
const isCrashCloseWorker = process.env[CRASH_CLOSE_ENV] !== undefined;
const mainDescribe = isConcurrentCloseWorker || isCrashCloseWorker ? describe.skip : describe;
const UPSTREAM_CODEX_SKILLS = [
  "map-check",
  "map-efficient",
  "map-explain",
  "map-fast",
  "map-plan",
  "map-review",
  "map-understand",
  "map-upgrade",
] as const;
const OFFICIAL_MANAGEMENT_MODES = {
  fenced: [
    ".agents/skills/map-check/SKILL.md",
    ".agents/skills/map-efficient/SKILL.md",
    ".agents/skills/map-efficient/efficient-reference.md",
    ".agents/skills/map-explain/SKILL.md",
    ".agents/skills/map-fast/SKILL.md",
    ".agents/skills/map-plan/SKILL.md",
    ".agents/skills/map-review/SKILL.md",
    ".agents/skills/map-review/adversarial-reference.md",
    ".agents/skills/map-review/review-reference.md",
    ".agents/skills/map-understand/SKILL.md",
    ".agents/skills/map-upgrade/SKILL.md",
    ".codex/agents/decomposer.toml",
    ".codex/agents/evaluator.toml",
    ".codex/agents/monitor.toml",
    ".codex/agents/predictor.toml",
    ".codex/agents/researcher.toml",
    ".codex/config.toml",
    ".codex/hooks/workflow-gate.py",
    "AGENTS.md",
  ],
  full: [
    ".map/scripts/classify_scope.py",
    ".map/scripts/diagnostics.py",
    ".map/scripts/map_orchestrator.py",
    ".map/scripts/map_step_runner.py",
    ".map/scripts/map_utils.py",
    ".map/scripts/scrub_internal_ids.py",
    ".map/scripts/sofa_client.py",
    ".map/scripts/validate_spec_citations.py",
    ".map/scripts/wayfind_runner.py",
  ],
  "hooks-merge": [".codex/hooks.json"],
} as const;
const OFFICIAL_CODEX_DESTINATIONS = Object.values(OFFICIAL_MANAGEMENT_MODES)
  .flat()
  .sort();
const roots: string[] = [];
const learningAuthorities = new Map<string, MapLearningRuntimeAuthority>();
const encoder = new TextEncoder();

afterEach(() => {
  learningAuthorities.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-map-"));
  roots.push(root);
  return root;
}

function writeRelative(root: string, path: string, bytes: Uint8Array | string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

interface MapFixture {
  root: string;
  expectation: MapProfileExpectation;
  managedBytes: Readonly<Record<string, Uint8Array>>;
  outsidePath: string;
}

interface MapProfileExpectation {
  version: string;
  sourceRevision: string;
  sourceArchiveSha256: string;
  provider: "codex";
  managedFileSha256: Readonly<Record<string, string>>;
  outsideScopeSha256: Readonly<Record<string, string>>;
}

interface InstalledManifestEntry {
  dest: string;
  management_mode: string;
}

function assertInstalledGolden(
  lockBytes: Uint8Array,
  lock: Record<string, unknown>,
): asserts lock is Record<string, unknown> & { entries: InstalledManifestEntry[] } {
  if (sha256(lockBytes) !== MAP_INSTALL_MANIFEST_SHA256) {
    throw new Error("installed MAP lock no longer matches the reviewed 3.28.1 golden");
  }
  if (
    lock.mapify_version !== MAP_VERSION
    || lock.provider !== "codex"
    || JSON.stringify(lock.providers) !== JSON.stringify(["codex"])
    || JSON.stringify(lock.config_entries) !== JSON.stringify([])
    || !Array.isArray(lock.entries)
  ) {
    throw new Error("installed MAP lock has unexpected provider or schema metadata");
  }
  const entries = lock.entries as Array<Record<string, unknown>>;
  const destinations = entries.map((entry) => entry.dest).sort();
  if (JSON.stringify(destinations) !== JSON.stringify(OFFICIAL_CODEX_DESTINATIONS)) {
    throw new Error("installed MAP lock destination set differs from the reviewed golden");
  }
  for (const [mode, expectedDestinations] of Object.entries(OFFICIAL_MANAGEMENT_MODES)) {
    const actualDestinations = entries
      .filter((entry) => entry.management_mode === mode)
      .map((entry) => entry.dest)
      .sort();
    if (JSON.stringify(actualDestinations) !== JSON.stringify([...expectedDestinations].sort())) {
      throw new Error(`installed MAP lock ${mode} ownership differs from the reviewed golden`);
    }
  }
}

function createMapFixture(): MapFixture {
  const root = tempRoot();
  const lockBytes = readFileSync(INSTALLED_MAP_LOCK_PATH);
  const lock = JSON.parse(lockBytes.toString("utf8")) as Record<string, unknown>;
  assertInstalledGolden(lockBytes, lock);
  const managedBytes: Record<string, Uint8Array> = {};
  for (const { dest } of lock.entries) {
    const bytes = readFileSync(join(PROJECT_ROOT, dest));
    managedBytes[dest] = bytes;
    writeRelative(root, dest, bytes);
  }
  writeRelative(root, ".map/mapify.lock.json", lockBytes);
  writeRelative(root, ".map/config.yaml", readFileSync(INSTALLED_MAP_CONFIG_PATH));
  writeRelative(root, ".agents/skills/map-learn/SKILL.md", "# Local provider-neutral learning adapter\n");
  writeRelative(
    root,
    ".codex/hooks/agent-collab-map-gate.py",
    readFileSync(join(PROJECT_ROOT, ".codex/hooks/agent-collab-map-gate.py")),
  );

  const outsidePath = ".agents/skills/map-learn/SKILL.md";
  const outsideBytes = readFileSync(join(root, outsidePath));
  const hookPath = ".codex/hooks/agent-collab-map-gate.py";
  const hookBytes = readFileSync(join(root, hookPath));
  return {
    root,
    managedBytes,
    outsidePath,
    expectation: {
      version: MAP_VERSION,
      sourceRevision: MAP_SOURCE_REVISION,
      sourceArchiveSha256: MAP_SOURCE_ARCHIVE_SHA256,
      provider: "codex",
      managedFileSha256: Object.fromEntries(
        Object.entries(managedBytes).map(([path, bytes]) => [path, sha256(bytes)]),
      ),
      outsideScopeSha256: {
        [outsidePath]: sha256(outsideBytes),
        [hookPath]: sha256(hookBytes),
      },
    },
  };
}

function rewriteLock(root: string, mutate: (lock: Record<string, unknown>) => void): void {
  const path = join(root, ".map/mapify.lock.json");
  const lock = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(lock);
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
}

function rewriteConfig(root: string, mutate: (config: string) => string): void {
  const path = join(root, ".map/config.yaml");
  const original = readFileSync(path, "utf8");
  const updated = mutate(original);
  if (updated === original) throw new Error("config mutation did not change the golden fixture");
  writeFileSync(path, updated);
}

mainDescribe("MAP 3.28.1 Codex profile", () => {
  it("characterizes the installed producer-authentic Codex golden", () => {
    const fixture = createMapFixture();
    const lockBytes = readFileSync(join(fixture.root, ".map/mapify.lock.json"));
    const lock = JSON.parse(lockBytes.toString("utf8")) as {
      entries: InstalledManifestEntry[];
    };

    expect(sha256(lockBytes)).toBe(MAP_INSTALL_MANIFEST_SHA256);
    expect(lock.entries.map(({ dest }) => dest).sort()).toEqual(OFFICIAL_CODEX_DESTINATIONS);
    for (const [mode, destinations] of Object.entries(OFFICIAL_MANAGEMENT_MODES)) {
      expect(lock.entries.filter((entry) => entry.management_mode === mode)
        .map(({ dest }) => dest).sort()).toEqual([...destinations].sort());
    }
    const config = readFileSync(join(fixture.root, ".map/config.yaml"), "utf8");
    expect(config).toMatch(/^profile: full$/m);
    expect(config).toMatch(/^updates\.auto: false$/m);
    expect(Object.fromEntries(Object.entries(fixture.managedBytes)
      .map(([path, bytes]) => [path, sha256(bytes)])))
      .toEqual(fixture.expectation.managedFileSha256);
    expect(lock.entries.some(({ dest }) => dest === ".agents/skills/map-learn/SKILL.md"))
      .toBe(false);
  });

  it("MAP-001A validates the exact pin, complete upstream inventory, and disabled updates", async () => {
    const { validateMapProfile } = await import("../src/flow/map-profile.js");
    const fixture = createMapFixture();

    const receipt = validateMapProfile(fixture.root, fixture.expectation);

    expect(receipt).toMatchObject({
      version: MAP_VERSION,
      sourceRevision: MAP_SOURCE_REVISION,
      sourceArchiveSha256: MAP_SOURCE_ARCHIVE_SHA256,
      provider: "codex",
      profile: "full",
      updatesAuto: false,
      upstreamSkillInventory: [...UPSTREAM_CODEX_SKILLS],
    });
    expect(receipt.managedFileSha256).toEqual(fixture.expectation.managedFileSha256);
    expect(Object.keys(receipt.managedFileSha256).sort()).toEqual(OFFICIAL_CODEX_DESTINATIONS);
  });

  it("MAP-001A rejects version, provider, full-profile, update-policy, and inventory drift", async () => {
    const { validateMapProfile } = await import("../src/flow/map-profile.js");
    const wrongVersion = createMapFixture();
    rewriteLock(wrongVersion.root, (lock) => { lock.mapify_version = "3.28.2"; });
    expect(() => validateMapProfile(wrongVersion.root, wrongVersion.expectation)).toThrow(/version/i);

    const wrongProvider = createMapFixture();
    rewriteLock(wrongProvider.root, (lock) => { lock.provider = "claude"; });
    expect(() => validateMapProfile(wrongProvider.root, wrongProvider.expectation)).toThrow(/provider/i);

    const unexpectedMcpOwnership = createMapFixture();
    rewriteLock(unexpectedMcpOwnership.root, (lock) => {
      lock.config_entries = [{
        file: ".mcp.json",
        key_path: "mcpServers.map",
        installed_at: "2026-08-26T17:43:10Z",
        mapify_version: MAP_VERSION,
      }];
    });
    expect(() => validateMapProfile(unexpectedMcpOwnership.root, unexpectedMcpOwnership.expectation))
      .toThrow(/mcp|config|manifest/i);

    const reducedProfile = createMapFixture();
    rewriteConfig(reducedProfile.root, (config) => config.replace("profile: full", "profile: core"));
    expect(() => validateMapProfile(reducedProfile.root, reducedProfile.expectation))
      .toThrow(/profile|full/i);

    const liveAutomaticPromotion = createMapFixture();
    rewriteConfig(liveAutomaticPromotion.root, (config) =>
      config.replace("updates.auto: false", "updates.auto: true"));
    expect(() => validateMapProfile(liveAutomaticPromotion.root, liveAutomaticPromotion.expectation))
      .toThrow(/update/i);

    const missingSkill = createMapFixture();
    unlinkSync(join(missingSkill.root, ".agents/skills/map-upgrade/SKILL.md"));
    expect(() => validateMapProfile(missingSkill.root, missingSkill.expectation))
      .toThrow(/map-upgrade|inventory/i);

    const extraSkill = createMapFixture();
    const extraPath = ".agents/skills/map-debug/SKILL.md";
    const extraBytes = encoder.encode("# unexpected upstream skill\n");
    writeRelative(extraSkill.root, extraPath, extraBytes);
    rewriteLock(extraSkill.root, (lock) => {
      const entries = lock.entries as Array<Record<string, unknown>>;
      entries.push({
        ...entries[0],
        dest: extraPath,
        content_hash: sha256(extraBytes),
      });
    });
    expect(() => validateMapProfile(extraSkill.root, extraSkill.expectation))
      .toThrow(/map-debug|inventory/i);

    const missingLocalAdapter = createMapFixture();
    unlinkSync(join(missingLocalAdapter.root, ".agents/skills/map-learn/SKILL.md"));
    expect(() => validateMapProfile(missingLocalAdapter.root, missingLocalAdapter.expectation))
      .toThrow(/map-learn|local adapter/i);
  });

  it.each([
    ".agents/skills/map-review/review-reference.md",
    ".codex/agents/evaluator.toml",
    ".codex/hooks/workflow-gate.py",
    ".map/scripts/map_utils.py",
    "AGENTS.md",
  ])("MAP-001A rejects a missing official managed destination: %s", async (destination) => {
    const { validateMapProfile } = await import("../src/flow/map-profile.js");
    const fixture = createMapFixture();
    unlinkSync(join(fixture.root, destination));

    expect(() => validateMapProfile(fixture.root, fixture.expectation))
      .toThrow(/managed|missing|inventory|manifest/i);
  });

  it.each([
    ["fenced", ".codex/config.toml", "full"],
    ["full", ".map/scripts/map_utils.py", "fenced"],
    ["hooks-merge", ".codex/hooks.json", "full"],
  ] as const)("MAP-001A rejects %s management-mode drift", async (_mode, destination, driftedMode) => {
    const { validateMapProfile } = await import("../src/flow/map-profile.js");
    const fixture = createMapFixture();
    rewriteLock(fixture.root, (lock) => {
      const entry = (lock.entries as Array<Record<string, unknown>>)
        .find((item) => item.dest === destination)!;
      entry.management_mode = driftedMode;
    });

    expect(() => validateMapProfile(fixture.root, fixture.expectation))
      .toThrow(/management|mode|manifest/i);
  });

  it("MAP-001A verifies raw managed bytes rather than trusting manifest hashes", async () => {
    const { validateMapProfile } = await import("../src/flow/map-profile.js");
    const fixture = createMapFixture();
    const target = ".agents/skills/map-plan/SKILL.md";
    writeRelative(fixture.root, target, "# map-plan\r\nmanaged\r\n");

    expect(() => validateMapProfile(fixture.root, fixture.expectation))
      .toThrow(/managed|content|digest|sha256/i);
  });

  it("MAP-001A rejects outside-scope drift and an upstream claim over local map-learn", async () => {
    const { validateMapProfile } = await import("../src/flow/map-profile.js");
    const outsideDrift = createMapFixture();
    writeRelative(outsideDrift.root, outsideDrift.outsidePath, "changed by installer\n");
    expect(() => validateMapProfile(outsideDrift.root, outsideDrift.expectation))
      .toThrow(/outside|scope|user-owned/i);

    const claimedAdapter = createMapFixture();
    rewriteLock(claimedAdapter.root, (lock) => {
      const entries = lock.entries as Array<Record<string, unknown>>;
      entries.push({
        ...entries[0],
        dest: ".agents/skills/map-learn/SKILL.md",
        content_hash: sha256(readFileSync(
          join(claimedAdapter.root, ".agents/skills/map-learn/SKILL.md"),
        )),
      });
    });
    expect(() => validateMapProfile(claimedAdapter.root, claimedAdapter.expectation))
      .toThrow(/map-learn|local adapter|manifest/i);
  });

  it("MAP-001B routes Codex apply_patch through the upstream editing phase gate", () => {
    const fixture = createMapFixture();
    const invoke = () => spawnSync(
      "python3",
      [join(fixture.root, ".codex/hooks/agent-collab-map-gate.py")],
      {
        cwd: fixture.root,
        env: { ...process.env, CLAUDE_PROJECT_DIR: fixture.root },
        input: JSON.stringify({
          tool_name: "apply_patch",
          tool_input: "*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch",
        }),
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    writeRelative(fixture.root, ".map/default/step_state.json", `${JSON.stringify({
      current_step_phase: "DECOMPOSE",
      current_subtask_id: "subtask-1",
      workflow_status: "IN_PROGRESS",
    })}\n`);
    const blocked = invoke();
    expect(blocked.status).toBe(0);
    expect(JSON.parse(blocked.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });

    writeRelative(fixture.root, ".map/default/step_state.json", `${JSON.stringify({
      current_step_phase: "ACTOR",
      current_subtask_id: "subtask-1",
      workflow_status: "IN_PROGRESS",
    })}\n`);
    const allowed = invoke();
    expect(allowed.status).toBe(0);
    expect(JSON.parse(allowed.stdout)).toEqual({});
  });
});

const MAP_MANIFEST_SHA256 = "b".repeat(64);
const learningCandidate: MapLearningCandidate = {
  schemaVersion: "map-learning-candidate/v1",
  rule: "Reject promotion when an exact-packet review receipt is stale.",
  controlIds: ["CTRL-009"],
  consumerScopes: ["codex", "grok", "claude"],
  revision: 1,
};

function learningHandoffBytes(
  root: string,
  overrides: Record<string, unknown> = {},
  candidate: MapLearningCandidate = learningCandidate,
): Uint8Array {
  const prepared = prepareLearningFixture({ projectRoot: root, candidate,
    mapVersion: MAP_VERSION, mapManifestSha256: MAP_MANIFEST_SHA256 });
  const handoff = JSON.parse(new TextDecoder().decode(prepared.handoffBytes));
  return encoder.encode(`${JSON.stringify({ ...handoff, ...overrides })}\n`);
}

function learningCloseInput(root: string, handoffBytes?: Uint8Array): MapLearningCloseInput {
  const prepared = prepareLearningFixture({ projectRoot: root, candidate: learningCandidate,
    mapVersion: MAP_VERSION, mapManifestSha256: MAP_MANIFEST_SHA256 });
  const existing = learningAuthorities.get(root);
  if (!existing) learningAuthorities.set(root, prepared.authority);
  const input = prepared.input;
  return handoffBytes === undefined ? input : { ...input, handoffBytes };
}

function learningCloseInputForCandidate(root: string, candidate: MapLearningCandidate): MapLearningCloseInput {
  const prepared = prepareLearningFixture({ projectRoot: root, candidate,
    mapVersion: MAP_VERSION, mapManifestSha256: MAP_MANIFEST_SHA256 });
  const existing = learningAuthorities.get(root);
  if (!existing) learningAuthorities.set(root, prepared.authority);
  return prepared.input;
}

function learningAuthority(root: string): MapLearningRuntimeAuthority {
  learningCloseInput(root);
  return learningAuthorities.get(root)!;
}

function learningRegistry(
  root: string,
  authority = learningAuthority(root),
): MapLearningAdministration {
  return new MapLearningAdministration({
    controlRoot: root,
    databasePath: authority.databasePath,
    ...(authority.controlFingerprint ? { controlFingerprint: authority.controlFingerprint } : {}),
    ...(authority.promotionCheckpoint ? { promotionCheckpoint: authority.promotionCheckpoint } : {}),
  });
}

async function expectLearningCloseToReject(
  action: () => unknown,
  pattern: RegExp,
): Promise<void> {
  await expect(Promise.resolve().then(action)).rejects.toThrow(pattern);
}

interface ConcurrentCloseOutcome {
  pid: number;
  record: { recordId: string; revision: number };
}

interface ConcurrentCloseWorkerPayload {
  registryRoot: string;
  readyPath: string;
  resultPath: string;
  startPath: string;
  input: Omit<MapLearningCloseInput, "handoffBytes" | "taskPacketBytes"> & {
    handoffBytesBase64: string;
    taskPacketBytesBase64: string;
  };
}

interface CrashCloseWorkerPayload {
  registryRoot: string;
  killedPidPath: string;
  input: ConcurrentCloseWorkerPayload["input"];
}

if (isConcurrentCloseWorker) {
  describe("MAP learning cross-process worker", () => {
    it("waits at the rendezvous before closing one duplicate learning record", async () => {
      const payloadBytes = Buffer.from(process.env[CONCURRENT_CLOSE_ENV]!, "base64");
      const payload = JSON.parse(payloadBytes.toString("utf8")) as ConcurrentCloseWorkerPayload;
      writeFileSync(payload.readyPath, String(process.pid));
      const deadline = Date.now() + 15_000;
      while (!existsSync(payload.startPath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      if (!existsSync(payload.startPath)) throw new Error("concurrency rendezvous was not released");
      const { handoffBytesBase64, taskPacketBytesBase64, ...input } = payload.input;
      const databasePath = join(
        payload.registryRoot,
        "node_modules/.agent-collab-test-state/collaboration.db",
      );
      const record = await Promise.resolve(new MapLearningAdministration({
        controlRoot: payload.registryRoot,
        databasePath,
      }).close({
        ...input,
        handoffBytes: Buffer.from(handoffBytesBase64, "base64"),
        taskPacketBytes: Buffer.from(taskPacketBytesBase64, "base64"),
      }));
      writeFileSync(payload.resultPath, `${JSON.stringify({ pid: process.pid, record })}\n`);
    }, 20_000);
  });
}

if (isCrashCloseWorker) {
  describe("MAP learning crash worker", () => {
    it("is killed after publishing the journaled candidate", async () => {
      const payloadBytes = Buffer.from(process.env[CRASH_CLOSE_ENV]!, "base64");
      const payload = JSON.parse(payloadBytes.toString("utf8")) as CrashCloseWorkerPayload;
      const { handoffBytesBase64, taskPacketBytesBase64, ...input } = payload.input;
      const databasePath = join(
        payload.registryRoot,
        "node_modules/.agent-collab-test-state/collaboration.db",
      );
      new MapLearningAdministration({
        controlRoot: payload.registryRoot,
        databasePath,
        promotionCheckpoint: (phase) => {
          if (phase === "after_publish") {
            writeFileSync(payload.killedPidPath, `${process.pid}\n`);
            process.kill(process.pid, "SIGKILL");
          }
        },
      }).close({
        ...input,
        handoffBytes: Buffer.from(handoffBytesBase64, "base64"),
        taskPacketBytes: Buffer.from(taskPacketBytesBase64, "base64"),
      });
      throw new Error("crash worker survived its required SIGKILL checkpoint");
    }, 20_000);
  });
}

async function waitForWorkerRendezvous(
  readyRoot: string,
  count: number,
  workers: ReadonlyArray<{ child: ReturnType<typeof spawn> }>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (Array.from({ length: count }, (_, index) =>
      existsSync(join(readyRoot, String(index)))).every(Boolean)) return;
    if (workers.some(({ child }) => child.exitCode !== null || child.signalCode !== null)) {
      throw new Error("MAP learning worker exited before the concurrency rendezvous");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for MAP learning workers to reach the concurrency rendezvous");
}

async function closeLearningConcurrently(
  registryRoot: string,
  input: MapLearningCloseInput,
  count: number,
): Promise<ConcurrentCloseOutcome[]> {
  const coordinationRoot = tempRoot();
  const readyRoot = join(coordinationRoot, "ready");
  const resultRoot = join(coordinationRoot, "result");
  const startPath = join(coordinationRoot, "start");
  mkdirSync(readyRoot, { recursive: true });
  mkdirSync(resultRoot, { recursive: true });
  const { handoffBytes, taskPacketBytes, ...jsonInput } = input;

  const workers = Array.from({ length: count }, (_, index) => {
    const resultPath = join(resultRoot, `${index}.json`);
    const payload: ConcurrentCloseWorkerPayload = {
      registryRoot,
      readyPath: join(readyRoot, String(index)),
      resultPath,
      startPath,
      input: {
        ...jsonInput,
        handoffBytesBase64: Buffer.from(handoffBytes).toString("base64"),
        taskPacketBytesBase64: Buffer.from(taskPacketBytes).toString("base64"),
      },
    };
    const child = spawn(process.execPath, [
      join(PROJECT_ROOT, "node_modules/vitest/vitest.mjs"),
      "run",
      "tests/map-framework-integration.test.ts",
      "--reporter=dot",
      "--maxWorkers=1",
      "--fileParallelism=false",
    ], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        [CONCURRENT_CLOSE_ENV]: Buffer.from(JSON.stringify(payload)).toString("base64"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const outcome = new Promise<
      { ok: true; value: ConcurrentCloseOutcome } | { ok: false; error: string }
    >((resolve) => {
      child.once("error", (error) => resolve({ ok: false, error: error.message }));
      child.once("close", (code, signal) => {
        if (code !== 0 || !existsSync(resultPath)) {
          resolve({
            ok: false,
            error: `worker ${index} exited code=${String(code)} signal=${String(signal)}: ${stderr || stdout}`,
          });
          return;
        }
        resolve({ ok: true, value: JSON.parse(readFileSync(resultPath, "utf8")) });
      });
    });
    return { child, outcome };
  });
  const allOutcomes = Promise.all(workers.map(({ outcome }) => outcome));

  try {
    await waitForWorkerRendezvous(readyRoot, count, workers);
    writeFileSync(startPath, "start\n");
    const outcomes = await allOutcomes;
    const failure = outcomes.find((outcome) => !outcome.ok);
    if (failure !== undefined && !failure.ok) throw new Error(failure.error);
    return outcomes.map((outcome) => {
      if (!outcome.ok) throw new Error(outcome.error);
      return outcome.value;
    });
  } finally {
    for (const { child } of workers) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await allOutcomes;
  }
}

mainDescribe("provider-neutral MAP learning registry", { timeout: 30_000 }, () => {
  it("MAP-003A keeps the unconfigured mutable registry outside the module API", async () => {
    const learning = await import("../src/flow/map-learning.js");
    expect(learning).not.toHaveProperty("MapLearningRegistry");
  });

  it("MAP-003A does not use the general delivery document as runtime policy", async () => {
    const root = tempRoot();
    rmSync(join(root, "docs/evidence-gated-flow-v1/flow-definition.json"), { force: true });

    const valid = learningCloseInput(root);
    const taskPacket = JSON.parse(new TextDecoder().decode(valid.taskPacketBytes)) as
      Record<string, unknown>;
    expect(taskPacket).not.toHaveProperty("definitionSha256");
    expect(await Promise.resolve(learningRegistry(root).close(valid)))
      .toMatchObject({ controlIds: ["CTRL-009"], revision: 1 });
  });

  it("MAP-003A rejects stale task, manifest, and handoff provenance", async () => {
    const root = tempRoot();
    const registry = learningRegistry(root);
    const valid = learningCloseInput(root);

    await expectLearningCloseToReject(() => registry.close({
      ...valid,
      taskPacketBytes: encoder.encode("not a canonical task packet\n"),
    }), /stale|provenance|task packet/i);
    await expectLearningCloseToReject(() => registry.close({
      ...valid,
      mapManifestSha256: "d".repeat(64),
    }), /stale|provenance|manifest/i);
    await expectLearningCloseToReject(() => registry.close(learningCloseInput(root, learningHandoffBytes(root, {
      mapManifestSha256: "e".repeat(64),
    }))), /stale|provenance|manifest/i);
  });

  it("MAP-003A rejects MAP-version drift and invalid handoff or candidate schemas", async () => {
    const root = tempRoot();
    const registry = learningRegistry(root);
    const valid = learningCloseInput(root);

    await expectLearningCloseToReject(() => registry.close({
      ...valid,
      mapVersion: "3.28.2",
    }), /stale|provenance|version/i);
    await expectLearningCloseToReject(() => registry.close(learningCloseInput(root, learningHandoffBytes(root, {
      schemaVersion: "learning-handoff/v0",
    }))), /schema|handoff/i);
    await expectLearningCloseToReject(() => registry.close({
      ...valid,
      candidate: {
        ...learningCandidate,
        schemaVersion: "map-learning-candidate/v0",
      },
    }), /schema|candidate/i);
  });

  it("MAP-003A content-addresses exact handoff and validated candidate bytes", async () => {
    const root = tempRoot();
    const registry = learningRegistry(root);
    const valid = learningCloseInput(root);
    const compact = await Promise.resolve(registry.close(valid));
    const reformattedHandoff = encoder.encode(JSON.stringify(JSON.parse(
      new TextDecoder().decode(valid.handoffBytes),
    ), null, 2));
    const replay = await Promise.resolve(registry.close(valid));
    await expectLearningCloseToReject(() => registry.close({ ...valid,
      handoffBytes: reformattedHandoff }), /CAS conflict/i);
    const conflictingCandidate: MapLearningCandidate = {
        ...learningCandidate,
        rule: "Reject promotion when an exact-packet artifact hash is stale.",
      };
    await expectLearningCloseToReject(() => registry.close(
      learningCloseInputForCandidate(root, conflictingCandidate),
    ), /CAS conflict/i);
    const advancedCandidate = { ...learningCandidate, revision: 2 };
    const advanced = await Promise.resolve(registry.close(
      learningCloseInputForCandidate(root, advancedCandidate),
    ));

    expect(compact).toMatchObject({
      schemaVersion: "map-learning-record/v2",
      taskPacketSha256: sha256(valid.taskPacketBytes),
      handoffSha256: sha256(valid.handoffBytes),
      mapVersion: MAP_VERSION,
      mapManifestSha256: MAP_MANIFEST_SHA256,
      rule: learningCandidate.rule,
      controlIds: [...learningCandidate.controlIds],
      consumerScopes: [...learningCandidate.consumerScopes],
      revision: 1,
    });
    expect(compact.recordId).toMatch(/^[a-f0-9]{64}$/);
    expect(replay.recordId).toBe(compact.recordId);
    expect(advanced).toMatchObject({ revision: 2 });
    expect(advanced.recordId).not.toBe(compact.recordId);
  }, 30_000);

  it("reopens legacy v1 records without widening their explicit provider scope", () => {
    const root = tempRoot();
    const mapManifestSha256 = "c".repeat(64);
    const taskPacketSha256 = "d".repeat(64);
    const handoffSha256 = "e".repeat(64);
    const candidate = {
      schemaVersion: "map-learning-candidate/v1",
      rule: "Preserve verified legacy learning during provider expansion.",
      controlIds: ["CTRL-001"],
      consumerScopes: ["codex", "grok"],
      revision: 1,
    } as const;
    const candidateSha256 = sha256(`${JSON.stringify(candidate)}\n`);
    const recordId = sha256(`${handoffSha256}\n${candidateSha256}\n`);
    const record = {
      schemaVersion: "map-learning-record/v1",
      recordId,
      taskPacketSha256,
      handoffSha256,
      candidateSha256,
      mapVersion: MAP_VERSION,
      mapManifestSha256,
      findingIds: ["FIND-001"],
      rule: candidate.rule,
      controlIds: [...candidate.controlIds],
      consumerScopes: [...candidate.consumerScopes],
      revision: 1,
    };
    writeRelative(root, `.map/agent-collab-admin/learning/records/${recordId}.json`,
      `${JSON.stringify(record)}\n`);
    writeRelative(root, ".map/agent-collab-admin/learning/head.json", `${JSON.stringify({
      schemaVersion: "map-learning-head/v1",
      revision: 1,
      recordId,
      mapVersion: MAP_VERSION,
      mapManifestSha256,
    })}\n`);
    const registry = new MapLearningAdministration({ controlRoot: root, databasePath: ":memory:" });
    const profile = { mapVersion: MAP_VERSION, mapManifestSha256 };
    const codex = JSON.parse(Buffer.from(registry.projection("codex", profile).bytes).toString("utf8"));
    const grok = JSON.parse(Buffer.from(registry.projection("grok", profile).bytes).toString("utf8"));
    const claude = JSON.parse(Buffer.from(registry.projection("claude", profile).bytes).toString("utf8"));
    expect(codex.records).toEqual([record]);
    expect(grok.records).toEqual([record]);
    expect(claude.records).toEqual([]);
    expect(readFileSync(join(root, `.map/agent-collab-admin/learning/records/${recordId}.json`), "utf8"))
      .toBe(`${JSON.stringify(record)}\n`);
  });

  it("MAP-003B rejects stale, conflicting, and skipped learning revisions", async () => {
    const root = tempRoot();
    const registry = learningRegistry(root);
    await Promise.resolve(registry.close(learningCloseInput(root)));

    await expectLearningCloseToReject(() => registry.close(
      learningCloseInputForCandidate(root, { ...learningCandidate, revision: 3 }),
    ), /exactly one/i);
    await expectLearningCloseToReject(() => registry.close(
      learningCloseInputForCandidate(root, { ...learningCandidate, rule: "conflicting revision one" }),
    ), /CAS conflict/i);
  }, 30_000);

  it("MAP-003B converges rendezvoused cross-process duplicate closes on one durable record", async () => {
    const root = tempRoot();
    const valid = learningCloseInput(root);
    const outcomes = await closeLearningConcurrently(root, valid, 8);
    expect(new Set(outcomes.map(({ pid }) => pid)).size).toBe(8);
    const recordIds = new Set(outcomes.map(({ record }) => record.recordId));

    expect(recordIds.size).toBe(1);
    const [recordId] = [...recordIds];
    const recordsPath = join(root, ".map/agent-collab-admin/learning/records");
    expect(readdirSync(recordsPath).sort()).toEqual([`${recordId}.json`]);
    expect(JSON.parse(readFileSync(join(recordsPath, `${recordId}.json`), "utf8")))
      .toMatchObject({ recordId, revision: 1 });
    const replay = await Promise.resolve(learningRegistry(root).close(valid));
    expect(replay.recordId).toBe(recordId);
    expect(readdirSync(recordsPath).sort()).toEqual([`${recordId}.json`]);
  }, 30_000);

  it("MAP-003B rolls back a SIGKILL promotion journal to the existing head before retry", async () => {
    const root = tempRoot();
    const registry = learningRegistry(root);
    const first = await Promise.resolve(registry.close(learningCloseInput(root)));
    const nextInput = learningCloseInputForCandidate(root, { ...learningCandidate, revision: 2 });
    const { handoffBytes, taskPacketBytes, ...jsonInput } = nextInput;
    const payload: CrashCloseWorkerPayload = {
      registryRoot: root,
      killedPidPath: join(root, ".map/agent-collab-admin/killed-worker.pid"),
      input: {
        ...jsonInput,
        handoffBytesBase64: Buffer.from(handoffBytes).toString("base64"),
        taskPacketBytesBase64: Buffer.from(taskPacketBytes).toString("base64"),
      },
    };
    const child = spawnSync(process.execPath, [
      join(PROJECT_ROOT, "node_modules/vitest/vitest.mjs"),
      "run",
      fileURLToPath(import.meta.url),
      "--maxWorkers=1",
      "--no-file-parallelism",
      "--reporter=dot",
    ], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        [CRASH_CLOSE_ENV]: Buffer.from(JSON.stringify(payload)).toString("base64"),
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toMatch(/Worker exited unexpectedly/i);
    const killedPid = Number(readFileSync(payload.killedPidPath, "utf8").trim());
    expect(Number.isSafeInteger(killedPid) && killedPid > 0).toBe(true);
    expect(() => process.kill(killedPid, 0)).toThrow();
    unlinkSync(payload.killedPidPath);
    const learningRoot = join(root, ".map/agent-collab-admin/learning");
    expect(existsSync(join(learningRoot, "promotion-journal.json"))).toBe(true);

    const recovered = registry.projection("codex", {
      mapVersion: MAP_VERSION,
      mapManifestSha256: MAP_MANIFEST_SHA256,
    });
    expect(JSON.parse(new TextDecoder().decode(recovered.bytes)).records)
      .toEqual([expect.objectContaining({ recordId: first.recordId, revision: 1 })]);
    expect(existsSync(join(learningRoot, "promotion-journal.json"))).toBe(false);
    expect(readdirSync(join(learningRoot, "records"))).toEqual([`${first.recordId}.json`]);

    const second = await Promise.resolve(registry.close(nextInput));
    expect(second.revision).toBe(2);
    expect(new Set(readdirSync(join(learningRoot, "records"))))
      .toEqual(new Set([`${first.recordId}.json`, `${second.recordId}.json`]));
  }, 30_000);

  it("MAP-003A projects byte-identical current learning to Codex, Grok and Claude", async () => {
    const root = tempRoot();
    const registry = learningRegistry(root);
    await Promise.resolve(registry.close(learningCloseInput(root)));

    const profile = { mapVersion: MAP_VERSION, mapManifestSha256: MAP_MANIFEST_SHA256 };
    const codex = await Promise.resolve(registry.projection("codex", profile));
    const grok = await Promise.resolve(registry.projection("grok", profile));
    const claude = await Promise.resolve(registry.projection("claude", profile));

    expect(codex).toEqual(grok);
    expect(claude).toEqual(codex);
    expect(codex.digest).toBe(sha256(codex.bytes));
    expect(new TextDecoder().decode(codex.bytes)).toContain(learningCandidate.rule);
    expect(() => registry.projection("codex", {
      ...profile,
      mapManifestSha256: "c".repeat(64),
    })).toThrow(/current installed profile/i);
  });
});
