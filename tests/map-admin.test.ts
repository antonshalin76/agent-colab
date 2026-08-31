import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertCurrentMapLearningLaunchBinding,
  assertMapRuntimeToolTreeIdentity,
  createMapLearningLaunchBinding,
  formatMapLearningLaunchBindingContext,
  fingerprintMapRuntimeToolTree,
  ConfiguredMapControlPlane,
  MapControlPlane,
  projectMapLearning,
  verifyInstalledMapProfile,
} from "../src/flow/map-admin.js";
import { prepareLearningFixture } from "./map-learning-fixture.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_LOCK_PATH = "docs/evidence-gated-flow-v1/map-profile-lock.json";
const MAP_MANIFEST_PATH = ".map/mapify.lock.json";
const MAP_VERSION = "3.28.1";
const encoder = new TextEncoder();
const roots: string[] = [];

interface CheckedInProfileLock {
  schemaVersion: "map-profile-lock/v1";
  version: string;
  sourceRevision: string;
  sourceArchiveSha256: string;
  provider: "codex";
  updateTool: {
    kind: "uv";
    version: string;
    executablePath: string;
    executableSha256: string;
  };
  sandboxTool: {
    kind: "bubblewrap";
    version: string;
    executablePath: string;
    executableSha256: string;
  };
  runtimeTool: {
    kind: "mapify-cli";
    version: string;
    toolRoot: string;
    executablePath: string;
    executableSha256: string;
    toolTreeSha256: string;
    pythonRealPath: string;
    pythonSha256: string;
  };
  mapManifestSha256: string;
  mapConfigSha256: string;
  managedFileSha256: Record<string, string>;
  outsideScopeSha256: Record<string, string>;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tempRoot(prefix = "agent-collab-map-admin-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function copyRelative(sourceRoot: string, targetRoot: string, relativePath: string): void {
  const target = join(targetRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(sourceRoot, relativePath), target);
}

function readCheckedInLock(root = PROJECT_ROOT): CheckedInProfileLock {
  return JSON.parse(readFileSync(join(root, PROFILE_LOCK_PATH), "utf8")) as CheckedInProfileLock;
}

function createProfileFixture(): string {
  const root = tempRoot();
  const lock = readCheckedInLock();
  for (const path of Object.keys(lock.managedFileSha256)) copyRelative(PROJECT_ROOT, root, path);
  for (const path of Object.keys(lock.outsideScopeSha256)) copyRelative(PROJECT_ROOT, root, path);
  for (const path of [
    MAP_MANIFEST_PATH,
    ".map/config.yaml",
    ".agents/skills/map-learn/SKILL.md",
    PROFILE_LOCK_PATH,
  ]) copyRelative(PROJECT_ROOT, root, path);
  return root;
}

function learningBytes(root: string, options?: {
  controlFingerprint?: () => string;
  optionalReviewState?: "missing" | "grok_missing" | "claude_missing" |
    "pass" | "provider_unavailable" |
    "changes_requested" | "failed" | "needs_reconciliation";
  adverseAgent?: "grok" | "claude";
}) {
  const profileLock = readCheckedInLock(root);
  return prepareLearningFixture({
    projectRoot: root,
    mapVersion: MAP_VERSION,
    mapManifestSha256: profileLock.mapManifestSha256,
    candidate: {
    schemaVersion: "map-learning-candidate/v1",
    rule: "Block promotion when an exact-packet review receipt is stale.",
    controlIds: ["CTRL-009"],
    consumerScopes: ["codex", "grok", "claude"],
    revision: 1,
    },
    ...(options?.controlFingerprint ? { controlFingerprint: options.controlFingerprint } : {}),
    ...(options?.optionalReviewState ? { optionalReviewState: options.optionalReviewState } : {}),
    ...(options?.adverseAgent ? { adverseAgent: options.adverseAgent } : {}),
  });
}

function closeLearning(
  root: string,
  input: ReturnType<typeof learningBytes>,
  authority = input.authority,
) {
  const control = new ConfiguredMapControlPlane(authority.databasePath, {
    controlRoot: root,
    ...(authority.controlFingerprint ? { controlFingerprint: authority.controlFingerprint } : {}),
    ...(authority.promotionCheckpoint ? { promotionCheckpoint: authority.promotionCheckpoint } : {}),
  });
  try {
    return control.closeLearning(input);
  } finally {
    control.close();
  }
}

describe("local MAP administration adapter", { timeout: 15_000 }, () => {
  it("does not expose generic root-selectable MAP mutation entrypoints", async () => {
    const administration = await import("../src/flow/map-admin.js");
    const learning = await import("../src/flow/map-learning.js");
    expect(administration).not.toHaveProperty("closeMapLearningFromBytes");
    expect(learning).not.toHaveProperty("MapLearningRegistry");
    expect(MapControlPlane).toHaveLength(1);
  });

  it("strips root-selectable evidence mutation from production declarations", () => {
    const declarations = tempRoot("agent-collab-public-api-");
    const compiled = spawnSync(process.execPath, [
      join(PROJECT_ROOT, "node_modules/typescript/bin/tsc"),
      "-p",
      join(PROJECT_ROOT, "tsconfig.json"),
      "--emitDeclarationOnly",
      "--declarationMap",
      "false",
      "--sourceMap",
      "false",
      "--outDir",
      declarations,
    ], { cwd: PROJECT_ROOT, encoding: "utf8" });
    expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0);
    const evidenceDeclaration = readFileSync(
      join(declarations, "flow/evidence-ledger.d.ts"),
      "utf8",
    );
    const administrationDeclaration = readFileSync(
      join(declarations, "flow/map-admin.d.ts"),
      "utf8",
    );
    expect(evidenceDeclaration).not.toMatch(/FlowEvidenceLedger|LearningEvidenceExecutionInput/);
    expect(administrationDeclaration).not.toMatch(/FlowEvidenceLedger|LearningEvidenceExecutionInput/);
    expect(administrationDeclaration).toMatch(/export declare class MapControlPlane/);
  });

  it("verifies the installed MAP profile from the checked-in raw-byte lock", () => {
    const lock = readCheckedInLock();
    const manifestBytes = readFileSync(join(PROJECT_ROOT, MAP_MANIFEST_PATH));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      entries: Array<{ dest: string }>;
    };

    const receipt = verifyInstalledMapProfile(PROJECT_ROOT);

    expect(receipt).toMatchObject({
      version: MAP_VERSION,
      sourceRevision: lock.sourceRevision,
      provider: "codex",
      profile: "full",
      updatesAuto: false,
      mapManifestSha256: sha256(manifestBytes),
    });
    expect(receipt.managedFileSha256).toEqual(lock.managedFileSha256);
    expect(receipt.updateTool).toEqual(lock.updateTool);
    expect(receipt.sandboxTool).toEqual(lock.sandboxTool);
    expect(receipt.runtimeTool).toEqual(lock.runtimeTool);
    expect(manifest.entries.some(({ dest }) => dest === ".agents/skills/map-learn/SKILL.md"))
      .toBe(false);
  });

  it("fails closed when a managed file or the manifest bytes drift", () => {
    const managedDrift = createProfileFixture();
    writeFileSync(join(managedDrift, ".agents/skills/map-plan/SKILL.md"), "drift\n");
    expect(() => verifyInstalledMapProfile(managedDrift)).toThrow(/digest|managed|content/i);

    const manifestDrift = createProfileFixture();
    writeFileSync(join(manifestDrift, MAP_MANIFEST_PATH), `${readFileSync(
      join(manifestDrift, MAP_MANIFEST_PATH),
      "utf8",
    )}\n`);
    expect(() => verifyInstalledMapProfile(manifestDrift)).toThrow(/manifest.*digest/i);

    const configDrift = createProfileFixture();
    writeFileSync(join(configDrift, ".map/config.yaml"), `${readFileSync(
      join(configDrift, ".map/config.yaml"),
      "utf8",
    )}# drift\n`);
    expect(() => verifyInstalledMapProfile(configDrift)).toThrow(/configuration.*digest/i);
  });

  it("requires the exact two local adapter digests in the checked-in profile lock", () => {
    const root = createProfileFixture();
    const path = join(root, PROFILE_LOCK_PATH);
    const lock = JSON.parse(readFileSync(path, "utf8")) as CheckedInProfileLock;
    delete lock.outsideScopeSha256[".agents/skills/map-learn/SKILL.md"];
    writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
    expect(() => verifyInstalledMapProfile(root)).toThrow(/profile lock schema|map-learn/i);
  });

  it("rejects drift in the pinned updater, sandbox, or MAP runtime identity", () => {
    const updaterDrift = createProfileFixture();
    const updaterLockPath = join(updaterDrift, PROFILE_LOCK_PATH);
    const updaterLock = readCheckedInLock(updaterDrift);
    updaterLock.updateTool.executableSha256 = "0".repeat(64);
    writeFileSync(updaterLockPath, `${JSON.stringify(updaterLock, null, 2)}\n`);
    expect(() => verifyInstalledMapProfile(updaterDrift)).toThrow(/update tool.*identity/i);

    const sandboxDrift = createProfileFixture();
    const sandboxLockPath = join(sandboxDrift, PROFILE_LOCK_PATH);
    const sandboxLock = readCheckedInLock(sandboxDrift);
    sandboxLock.sandboxTool.executableSha256 = "0".repeat(64);
    writeFileSync(sandboxLockPath, `${JSON.stringify(sandboxLock, null, 2)}\n`);
    expect(() => verifyInstalledMapProfile(sandboxDrift)).toThrow(/sandbox tool.*identity/i);

    const runtimeDrift = createProfileFixture();
    const runtimeLockPath = join(runtimeDrift, PROFILE_LOCK_PATH);
    const runtimeLock = readCheckedInLock(runtimeDrift);
    runtimeLock.runtimeTool.toolTreeSha256 = "0".repeat(64);
    writeFileSync(runtimeLockPath, `${JSON.stringify(runtimeLock, null, 2)}\n`);
    expect(() => verifyInstalledMapProfile(runtimeDrift)).toThrow(/runtime tool.*identity/i);
  });

  it("includes executable Python bytecode in the MAP runtime tree identity", () => {
    const root = tempRoot("agent-collab-map-runtime-tree-");
    const bytecodeDirectory = join(root, "lib/python/site-packages/__pycache__");
    mkdirSync(bytecodeDirectory, { recursive: true });
    const bytecodePath = join(bytecodeDirectory, "mapify_cli.cpython-314.pyc");
    writeFileSync(bytecodePath, "first-bytecode");
    const before = fingerprintMapRuntimeToolTree(root);
    writeFileSync(bytecodePath, "mutated-bytecode");
    expect(fingerprintMapRuntimeToolTree(root)).not.toBe(before);
    writeFileSync(join(root, "lib/python/site-packages/mapify_cli.py"), "source");
    expect(fingerprintMapRuntimeToolTree(root)).not.toBe(before);
  });

  it("rejects a mutated candidate MAP runtime before execution", () => {
    const runtimeRoot = tempRoot("agent-collab-map-runtime-copy-");
    const pythonRoot = tempRoot("agent-collab-map-runtime-python-");
    const executablePath = join(runtimeRoot, "bin/mapify");
    const pythonPath = join(pythonRoot, "python3");
    mkdirSync(dirname(executablePath), { recursive: true });
    writeFileSync(executablePath, "mapify-runtime");
    writeFileSync(pythonPath, "python-runtime");
    chmodSync(executablePath, 0o700);
    chmodSync(pythonPath, 0o700);
    symlinkSync(pythonPath, join(runtimeRoot, "bin/python"));
    const expectation = {
      executableSha256: sha256(readFileSync(executablePath)),
      toolTreeSha256: fingerprintMapRuntimeToolTree(runtimeRoot),
      pythonRealPath: pythonPath,
      pythonSha256: sha256(readFileSync(pythonPath)),
    };
    expect(() => assertMapRuntimeToolTreeIdentity(runtimeRoot, expectation)).not.toThrow();
    writeFileSync(executablePath, "mutated-candidate-runtime");
    chmodSync(executablePath, 0o700);
    expect(() => assertMapRuntimeToolTreeIdentity(runtimeRoot, expectation))
      .toThrow(/runtime tool tree.*identity/i);
  });

  it("closes exact-byte learning with the required Codex quorum when optional providers are missing", () => {
    const root = createProfileFixture();
    const input = learningBytes(root);
    const mapConfigBefore = readFileSync(join(root, ".map/config.yaml"));
    const handoff = JSON.parse(Buffer.from(input.handoffBytes).toString("utf8")) as {
      reviewReceipts: Array<{ agent: string; role: string }>;
    };
    expect(handoff.reviewReceipts.map(({ agent, role }) => `${agent}:${role}`).sort()).toEqual([
      "codex:auditor",
      "codex:critic",
    ]);
    const beforePromotion = createMapLearningLaunchBinding(root, "codex");
    const beforePrompt = `${formatMapLearningLaunchBindingContext(beforePromotion)}\n\nreview`;

    const closed = closeLearning(root, input, input.authority);
    const codex = projectMapLearning(root, "codex");
    const grok = projectMapLearning(root, "grok");
    const claude = projectMapLearning(root, "claude");

    expect(closed.record).toMatchObject({
      taskPacketSha256: sha256(input.taskPacketBytes),
      handoffSha256: sha256(input.handoffBytes),
      candidateSha256: sha256(input.candidateBytes),
      mapVersion: MAP_VERSION,
      mapManifestSha256: closed.profile.mapManifestSha256,
      consumerScopes: ["codex", "grok", "claude"],
    });
    expect(codex.projection.digest).toBe(grok.projection.digest);
    expect(codex.projection.bytes).toEqual(grok.projection.bytes);
    expect(claude.projection).toEqual(codex.projection);
    expect(claude.profile).toEqual(codex.profile);
    expect(readFileSync(join(root, ".map/config.yaml"))).toEqual(mapConfigBefore);
    expect(JSON.parse(Buffer.from(codex.projection.bytes).toString("utf8")))
      .toMatchObject({ records: [{ recordId: closed.record.recordId }] });
    expect(readdirSync(join(root, ".map/agent-collab-admin/learning/records")))
      .toEqual([`${closed.record.recordId}.json`]);
    expect(() => assertCurrentMapLearningLaunchBinding(
      root,
      "codex",
      beforePromotion,
      beforePrompt,
    )).toThrow(/projection is stale/i);
    const current = createMapLearningLaunchBinding(root, "codex");
    expect(() => assertCurrentMapLearningLaunchBinding(
      root,
      "codex",
      current,
      `${formatMapLearningLaunchBindingContext(current)}\n\nreview`,
    )).not.toThrow();
    const claudeBinding = createMapLearningLaunchBinding(root, "claude");
    expect(claudeBinding.consumer).toBe("claude");
    expect(Object.keys(claudeBinding).sort()).toEqual([
      "consumer",
      "digest",
      "projectionBase64",
      "schemaVersion",
    ]);
    expect(() => assertCurrentMapLearningLaunchBinding(
      root,
      "claude",
      claudeBinding,
      `${formatMapLearningLaunchBindingContext(claudeBinding)}\n\nread-only review`,
    )).not.toThrow();
  });

  it("retains exact optional PASS receipts when diversity providers complete", () => {
    const root = createProfileFixture();
    const input = learningBytes(root, { optionalReviewState: "pass" });
    const handoff = JSON.parse(Buffer.from(input.handoffBytes).toString("utf8")) as {
      reviewReceipts: Array<{ agent: string; role: string }>;
    };
    expect(handoff.reviewReceipts.map(({ agent, role }) => `${agent}:${role}`).sort()).toEqual([
      "claude:auditor",
      "claude:critic",
      "codex:auditor",
      "codex:critic",
      "grok:auditor",
      "grok:critic",
    ]);
    expect(() => closeLearning(root, input, input.authority)).not.toThrow();
  });

  it.each([
    ["grok_missing", ["claude:auditor", "claude:critic", "codex:auditor", "codex:critic"]],
    ["claude_missing", ["codex:auditor", "codex:critic", "grok:auditor", "grok:critic"]],
  ] as const)("closes when exactly one optional provider is missing: %s", (optionalReviewState, expected) => {
    const root = createProfileFixture();
    const input = learningBytes(root, { optionalReviewState });
    const handoff = JSON.parse(Buffer.from(input.handoffBytes).toString("utf8")) as {
      reviewReceipts: Array<{ agent: string; role: string }>;
    };
    expect(handoff.reviewReceipts.map(({ agent, role }) => `${agent}:${role}`).sort()).toEqual(expected);
    expect(() => closeLearning(root, input, input.authority)).not.toThrow();
  });

  it("closes with explicit durable optional-provider unavailable outcomes", () => {
    const root = createProfileFixture();
    const input = learningBytes(root, { optionalReviewState: "provider_unavailable" });
    const handoff = JSON.parse(Buffer.from(input.handoffBytes).toString("utf8")) as {
      reviewReceipts: Array<{ agent: string; role: string }>;
    };
    expect(handoff.reviewReceipts.map(({ agent, role }) => `${agent}:${role}`).sort()).toEqual([
      "codex:auditor",
      "codex:critic",
    ]);
    expect(() => closeLearning(root, input, input.authority)).not.toThrow();
  });

  it.each((["grok", "claude"] as const).flatMap((adverseAgent) =>
    (["changes_requested", "failed", "needs_reconciliation"] as const)
      .map((optionalReviewState) => [adverseAgent, optionalReviewState] as const)))(
    "blocks learning closure for optional %s adverse state %s", (adverseAgent, optionalReviewState) => {
      const root = createProfileFixture();
      const input = learningBytes(root, { optionalReviewState, adverseAgent });
      expect(() => closeLearning(root, input, input.authority))
        .toThrow(/review barrier|durable PASS evidence/i);
    },
  );

  it("requires both Codex receipts and every completed optional PASS receipt", () => {
    for (const omittedPair of ["codex:critic", "grok:auditor"] as const) {
      const root = createProfileFixture();
      const input = learningBytes(root, { optionalReviewState: "pass" });
      const handoff = JSON.parse(Buffer.from(input.handoffBytes).toString("utf8")) as {
        reviewReceipts: Array<{ agent: string; role: string }>;
      };
      handoff.reviewReceipts = handoff.reviewReceipts.filter(
        ({ agent, role }) => `${agent}:${role}` !== omittedPair,
      );
      expect(() => closeLearning(root, {
        ...input,
        handoffBytes: encoder.encode(`${JSON.stringify(handoff)}\n`),
      }, input.authority), omittedPair).toThrow(/review receipt|Codex.*quorum|durable harness evidence/i);
    }
  });

  it("recovers promotion after an obsolete process lock is left by a crash", () => {
    const root = createProfileFixture();
    const obsoleteLock = join(root, ".map/agent-collab-admin/learning/promotion.lock");
    mkdirSync(join(root, ".map/agent-collab-admin/learning"), { recursive: true });
    writeFileSync(obsoleteLock, "999999\n");
    const input = learningBytes(root);
    expect(closeLearning(root, input, input.authority).record.revision).toBe(1);
    expect(existsSync(join(root, ".map/agent-collab-admin/learning/promotion.db"))).toBe(true);
  });

  it("rejects non-canonical candidate bytes and stale task provenance", () => {
    const root = createProfileFixture();
    const input = learningBytes(root);
    const candidate = JSON.parse(Buffer.from(input.candidateBytes).toString("utf8"));
    const reformattedCandidate = encoder.encode(JSON.stringify(candidate, null, 2));

    expect(() => closeLearning(root, {
      ...input,
      candidateBytes: reformattedCandidate,
    }, input.authority)).toThrow(/candidate.*canonical|exact.*candidate/i);

    expect(() => closeLearning(root, {
      ...input,
      taskPacketBytes: encoder.encode("different task packet bytes\n"),
    }, input.authority)).toThrow(/stale|provenance|task packet/i);
  });

  it("rejects project-root and learning-admin symbolic links before writing", () => {
    const root = createProfileFixture();
    const aliasParent = tempRoot("agent-collab-map-alias-");
    const alias = join(aliasParent, "project");
    symlinkSync(root, alias, "dir");
    expect(() => verifyInstalledMapProfile(alias)).toThrow(/symbolic link|canonical/i);

    const outside = tempRoot("agent-collab-map-outside-");
    symlinkSync(outside, join(root, ".map/agent-collab-admin"), "dir");
    const input = learningBytes(root);
    expect(() => closeLearning(root, input, input.authority))
      .toThrow(/symbolic link|admin|contain/i);
    expect(existsSync(join(outside, "learning"))).toBe(false);
  });

  it("rejects promotion database and journal symlinks before touching their targets", () => {
    for (const suffix of ["", "-journal"] as const) {
      const root = createProfileFixture();
      const administration = join(root, ".map/agent-collab-admin/learning");
      mkdirSync(administration, { recursive: true });
      const outside = join(tempRoot("agent-collab-map-db-target-"), "external.db");
      writeFileSync(outside, "outside sentinel\n", { mode: 0o644 });
      const before = readFileSync(outside);
      const beforeMode = statSync(outside).mode & 0o777;
      symlinkSync(outside, join(administration, `promotion.db${suffix}`));

      const input = learningBytes(root);
      expect(() => closeLearning(root, input, input.authority))
        .toThrow(/promotion database|canonical|regular file/i);
      expect(readFileSync(outside)).toEqual(before);
      expect(statSync(outside).mode & 0o777).toBe(beforeMode);
    }
  }, 15_000);

  it("rejects a promotion-state journal symlink before recovery or publication", () => {
    const root = createProfileFixture();
    const administration = join(root, ".map/agent-collab-admin/learning");
    mkdirSync(administration, { recursive: true });
    const outside = join(tempRoot("agent-collab-map-journal-target-"), "external.json");
    writeFileSync(outside, "outside sentinel\n");
    const before = readFileSync(outside);
    symlinkSync(outside, join(administration, "promotion-journal.json"));

    const input = learningBytes(root);
    expect(() => closeLearning(root, input, input.authority))
      .toThrow(/promotion journal|canonical regular file/i);
    expect(readFileSync(outside)).toEqual(before);
  });

  it("rejects unreviewed controls, incomplete finding closure, and secret-bearing rules", () => {
    const root = createProfileFixture();
    const input = learningBytes(root);
    const candidate = JSON.parse(Buffer.from(input.candidateBytes).toString("utf8")) as Record<string, unknown>;
    const handoff = JSON.parse(Buffer.from(input.handoffBytes).toString("utf8")) as Record<string, unknown>;
    const withCandidate = (next: Record<string, unknown>) => {
      const candidateBytes = encoder.encode(`${JSON.stringify(next)}\n`);
      const candidateSha256 = sha256(candidateBytes);
      const nextHandoff = structuredClone(handoff) as { candidateSha256: string; reviewReceipts: Array<{ candidateSha256: string }> };
      nextHandoff.candidateSha256 = candidateSha256;
      for (const receipt of nextHandoff.reviewReceipts) receipt.candidateSha256 = candidateSha256;
      return { ...input, candidateBytes, handoffBytes: encoder.encode(`${JSON.stringify(nextHandoff)}\n`) };
    };

    expect(() => closeLearning(root, withCandidate({ ...candidate,
      controlIds: ["CTRL-999"] }), input.authority)).toThrow(/unknown canonical control/i);
    expect(() => closeLearning(root, withCandidate({ ...candidate,
      rule: "Authorization: Bearer SECRET_LEARNING_TOKEN_123456" }), input.authority)).toThrow(/credential/i);

    const incomplete = structuredClone(handoff) as { findingClosures: unknown[] };
    incomplete.findingClosures = [];
    expect(() => closeLearning(root, { ...input,
      handoffBytes: encoder.encode(`${JSON.stringify(incomplete)}\n`) }, input.authority))
      .toThrow(/handoff|closure|schema/i);
  });

  it("rejects self-declared learning PASS receipts that do not resolve in runtime state", () => {
    const root = createProfileFixture();
    const input = learningBytes(root);
    const handoff = JSON.parse(Buffer.from(input.handoffBytes).toString("utf8")) as {
      reviewReceipts: Array<{ sessionId: string }>;
    };
    handoff.reviewReceipts[0]!.sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    expect(() => closeLearning(root, {
      ...input,
      handoffBytes: encoder.encode(`${JSON.stringify(handoff)}\n`),
    }, input.authority)).toThrow(/durable harness evidence|review receipt/i);
  });

  it("rejects source drift after the learning review passed", () => {
    const root = createProfileFixture();
    const input = learningBytes(root);
    writeFileSync(join(root, "post-review-drift.txt"), "changed after review\n");

    expect(() => closeLearning(root, input, input.authority))
      .toThrow(/source fingerprint.*stale|source.*drift/i);
  });

  it("closes a non-review finding by deriving stage and ORACLE-010 from its canonical lifecycle", () => {
    const root = createProfileFixture();
    const profileLock = readCheckedInLock(root);
    const input = prepareLearningFixture({
      projectRoot: root,
      mapVersion: MAP_VERSION,
      mapManifestSha256: profileLock.mapManifestSha256,
      candidate: {
        schemaVersion: "map-learning-candidate/v1",
        rule: "Reject learning evidence that does not resolve its canonical process execution.",
        controlIds: ["CTRL-014"],
        consumerScopes: ["codex", "grok", "claude"],
        revision: 1,
      },
      findingSpec: {
        owningStage: "90_learning_close",
        affectedScenarioId: "BDD-007",
        affectedControlId: "CTRL-014",
        missedStage: "90_learning_close",
        escapedOracleId: "ORACLE-010",
        testSystemOwnerId: "OWNER-007",
        preventionGuardId: "GUARD-010",
      },
    });

    expect(closeLearning(root, input, input.authority).record.controlIds)
      .toEqual(["CTRL-014"]);
    const taskPacket = JSON.parse(Buffer.from(input.taskPacketBytes).toString("utf8")) as {
      evidenceReceipts: Array<{ oracleId: string; stageId: string }>;
    };
    expect(taskPacket.evidenceReceipts.every(({ oracleId }) => oracleId === "ORACLE-010")).toBe(true);
    expect(taskPacket.evidenceReceipts.every(({ stageId }) => stageId === "90_learning_close")).toBe(true);
  });

  it.each(["source", "profile", "control"] as const)(
    "rolls back a newly published learning head when %s identity drifts at the post-publish checkpoint",
    (drift) => {
      const root = createProfileFixture();
      let controlFingerprint = "c".repeat(64);
      const input = learningBytes(root, drift === "control"
        ? { controlFingerprint: () => controlFingerprint }
        : undefined);
      const authority = {
        ...input.authority,
        promotionCheckpoint: (phase: "before_publish" | "after_publish") => {
          if (phase !== "after_publish") return;
          if (drift === "source") writeFileSync(join(root, "concurrent-source-drift.txt"), "drift\n");
          if (drift === "profile") writeFileSync(
            join(root, ".map/config.yaml"),
            `${readFileSync(join(root, ".map/config.yaml"), "utf8")}# drift\n`,
          );
          if (drift === "control") controlFingerprint = "d".repeat(64);
        },
      };

      expect(() => closeLearning(root, input, authority))
        .toThrow(/source|profile|digest|canonical runtime execution/i);
      const learningRoot = join(root, ".map/agent-collab-admin/learning");
      expect(existsSync(join(learningRoot, "head.json"))).toBe(false);
      expect(readdirSync(join(learningRoot, "records"))).toEqual([]);
    },
  );
});
