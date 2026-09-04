import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { LocalCollabService } from "../src/app/service.js";
import { MigrationCoordinator, initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { createCollabMcpServer } from "../src/mcp/server.js";
import { GraphFlowStore } from "../src/store/graph-flow-store.js";
import { RunStore } from "../src/store/run-store.js";
import { DurableWorker } from "../src/worker/durable-worker.js";
import { computeGraphDefinitionSha256 } from "../src/workflow/flow-contract.js";

import {
  AMD_ACCEPTED_AT,
  AMD_ACCEPTANCE_DELTA,
  AMD_ARCHITECTURE_EVIDENCE_SHA256,
  AMD_AUTHORIZATION_CAPTURED_AT,
  AMD_AUTHORIZATION_TEXT_SHA256,
  AMD_AUTHORITY_RECEIPT_FILE_SHA256,
  AMD_AUTHORITY_DELTA,
  AMD_AUTHORITY_RECEIPT_SHA256,
  AMD_CONTRACT_DELTA,
  AMD_EFFECTIVE_PLAN_SHA256,
  AMD_FILE_SHA256,
  AMD_RECORDED_AT,
  AMD_STG03_SOURCE_MANIFEST_SHA256,
  REVIEWED_COMMIT,
  REVIEWED_TREE,
  R2_PLAN_ID,
  R2_PLAN_SHA256,
  R2_START_SHA256,
  STG03_EVENT_SHA256,
  amendmentFixture,
  assertFixturePins,
  canonicalJson,
  createProgressFixture,
  eventArtifactFacts,
  progressRows,
  progressTableSnapshot,
  readR2ProgressEvent,
  rebindEventArtifact,
  removeProgressFixture,
  rewriteEventChain,
  sha256,
  sqliteSnapshot,
  withCanonicalHash,
  writeArtifact,
  type AmendmentFixture,
  type ArtifactFact,
  type JsonObject,
  type ProgressFixture,
  type TrustedAmendmentAuthority,
} from "./helpers/implementation-progress-fixture.js";

interface VerifiedProgressEvent {
  readonly event: JsonObject;
  readonly eventJson: string;
  readonly eventSha256: string;
}

interface VerifiedAmendment {
  readonly amendment: JsonObject;
  readonly authorityReceipt: JsonObject;
  readonly amendmentSha256: string;
  readonly authorityReceiptSha256: string;
  readonly effectivePlanSha256: string;
}

interface ProgressStoreAccess { readonly accessId: symbol }

declare const amendmentAcceptanceBrand: unique symbol;
interface AmendmentAcceptanceCapability {
  readonly [amendmentAcceptanceBrand]: true;
}

interface AmendmentCapabilityBinding {
  readonly databasePath: string;
  readonly amendmentId: "AMD-0001";
  readonly amendmentPath: string;
  readonly amendmentFileSha256: string;
  readonly authorityReceiptPath: string;
  readonly authorityReceiptFileSha256: string;
}

interface AmendmentAcceptanceAuthority {
  issuer: { issue(binding: AmendmentCapabilityBinding): AmendmentAcceptanceCapability };
  service: unknown;
  store: unknown;
}

interface ProgressStore {
  withImmediateTransaction<T>(operation: (access: ProgressStoreAccess) => T): T;
  appendVerifiedEvent(input: VerifiedProgressEvent): { eventId: string; sequence: number; replayed: boolean };
  appendVerifiedEventsAtomically(input: readonly VerifiedProgressEvent[]): { eventId: string; sequence: number; replayed: boolean };
  authorityIdentity(): { databasePath: string; generation: string };
  acceptVerifiedAmendment(input: { verifiedAmendment: VerifiedAmendment; acceptedAt: number }): {
    effectivePlanSha256: string;
    replayed: boolean;
  };
  snapshotProjection(): {
    watermarkSequence: number;
    watermarkEventSha256: string;
    events: readonly JsonObject[];
  };
  close(): void;
}

interface ProgressService {
  appendEvent(input: { event: JsonObject; eventJson: string }): {
    eventId: string;
    sequence: number;
    replayed: boolean;
  };
  acceptAmendment(
    input: AmendmentRequest,
    capability: AmendmentAcceptanceCapability,
  ): { effectivePlanSha256: string; replayed: boolean };
  verify(): {
    status: "verified";
    authority: "sqlite";
    progressEventCount: number;
    lastEventSha256: string;
    effectivePlanSha256: string;
    projectionStatus: "current" | "pending" | "stale";
    invalidatedEventIds: readonly string[];
    launchAccounting: {
      historical: {
        recordedCap: number;
        consumed: number;
        legacyNullDerivedZero: readonly string[];
      };
      postStart: {
        cap: number;
        consumed: number;
        remaining: number;
        costCapUsd: number;
        costConsumedUsd: number;
        costRemainingUsd: number;
      };
    };
  };
}

interface AmendmentRequest {
  amendmentPath: string;
  authorityReceiptPath: string;
  authorizationTextBytes: Buffer;
  acceptedAt: number;
}

interface AmendmentVerificationInput {
  amendment: JsonObject;
  authorityReceipt: JsonObject;
  authorizationTextBytes: Buffer;
  acceptedAt: number;
  evidenceArtifacts: readonly ArtifactFact[];
}

interface ProgressPureRuntime {
  verifyProgressEvent(input: {
    readonly existingEvents: readonly JsonObject[];
    readonly candidate: JsonObject;
    readonly eventJson: string;
    readonly artifactFacts: readonly ArtifactFact[];
    readonly startSha256: string;
    readonly baselinePlanSha256: string;
  }): VerifiedProgressEvent;
  reduceImplementationProgress(input: {
    readonly events: readonly JsonObject[];
    readonly startSha256: string;
    readonly baselinePlanSha256: string;
    readonly artifactFacts: readonly ArtifactFact[];
  }): {
    readonly effectivePlanSha256: string;
    readonly invalidatedEventIds: readonly string[];
    readonly eligibleStageIds: readonly string[];
    readonly completedStageIds: readonly string[];
  };
  verifyLiveProviderLaunchAccounting(input: {
    readonly implementationStart: JsonObject;
    readonly events: readonly JsonObject[];
    readonly artifactFacts: readonly ArtifactFact[];
  }): {
    readonly historical: {
      readonly recordedCap: number;
      readonly consumed: number;
      readonly legacyNullDerivedZero: readonly string[];
    };
    readonly postStart: {
      readonly cap: number;
      readonly consumed: number;
      readonly remaining: number;
      readonly costCapUsd: number;
      readonly costConsumedUsd: number;
      readonly costRemainingUsd: number;
    };
  };
}

interface ProgressRuntime {
  readonly Store: new (
    databasePath: string,
    options?: { faultInjector?: (point: string) => void; progressAuthority?: unknown; amendmentAuthority?: unknown },
  ) => ProgressStore;
  readonly Service: new (input: {
    store: ProgressStore;
    databasePath: string;
    readArtifact: (path: string) => Buffer;
    readProjection: () => { jsonl?: Buffer; markdown?: Buffer };
    sourceFacts: {
      start: JsonObject;
      planLock: JsonObject;
      planAnchorParent: string;
    };
    amendmentAuthority?: unknown;
    progressVerifier?: unknown;
  }) => ProgressService;
}

interface AmendmentRuntime {
  createAmendmentAcceptanceAuthority(
    trustedAuthority: TrustedAmendmentAuthority,
  ): AmendmentAcceptanceAuthority;
  verifyImplementationAmendment(
    input: AmendmentVerificationInput,
    trustedAuthority: TrustedAmendmentAuthority,
  ): VerifiedAmendment;
}

interface ProgressAuthorityComposition {
  verifier: {
    authorize(input: Parameters<ProgressPureRuntime["verifyProgressEvent"]>[0] & {
      storeIdentity: { databasePath: string; generation: string };
    }): VerifiedProgressEvent;
    authorizeReplay(input: {
      storeIdentity: { databasePath: string; generation: string };
      existingEvents: readonly JsonObject[];
      candidate: JsonObject;
      eventJson: string;
    }): VerifiedProgressEvent;
  };
  store: unknown;
}

interface BootstrapInput {
  readonly operationId: string;
  readonly gitRoot: string;
  readonly reviewedWorktreeParent: string;
  readonly sourceIdentity: { commitOid: string; treeOid: string };
  readonly stateDatabase: string;
  readonly historyDatabase: string;
}

declare const migrationAuthorityBrand: unique symbol;
interface MigrationAuthorityCapability { readonly [migrationAuthorityBrand]: true }
interface BootstrapComposition {
  bootstrapReviewedV4(input: BootstrapInput, authority: MigrationAuthorityCapability): Promise<unknown>;
}
interface MigrationAuthorityComposition {
  issuer: { issue(input: {
    readonly operationId: string;
    readonly consumer: "codex:/root:state-v4-reviewed-bootstrap";
    readonly scope: "reviewed-state-v4-migration";
    readonly sourceIdentity: { readonly commitOid: typeof REVIEWED_COMMIT; readonly treeOid: typeof REVIEWED_TREE };
    readonly stateDatabase: string;
    readonly historyDatabase: string;
  }): MigrationAuthorityCapability };
  consumer: unknown;
  close(): void;
}

type CreateReviewedV4Bootstrap = (input: {
  readonly process: {
    run(invocation: {
      readonly executable: string;
      readonly args: readonly string[];
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
    }): Promise<{
      readonly status: number | null;
      readonly stdout: string;
      readonly stderr: string;
    }>;
  };
  readonly quiescence: {
    assertServiceInactive(input: { readonly stateDatabase: string; readonly historyDatabase: string }): void;
    assertNoOpenDatabaseFds(input: { readonly stateDatabase: string; readonly historyDatabase: string }): void;
    acquireExclusiveWriteFence(input: {
      readonly stateDatabase: string;
      readonly historyDatabase: string;
    }): { assertCurrent(): void; release(): void };
  };
  readonly migrationAuthority: unknown;
}) => BootstrapComposition;

interface ProjectionFiles {
  publish(input: {
    jsonlBytes: Buffer;
    markdownBytes: Buffer;
    watermarkSequence: number;
    watermarkEventSha256: string;
  }): { jsonlPath: string; markdownPath: string };
  verify(input: { watermarkSequence: number; watermarkEventSha256: string }): void;
}

interface Projector {
  project(input: { publishedAt: number }): {
    watermarkSequence: number;
    watermarkEventSha256: string;
    jsonlPath: string;
    markdownPath: string;
  };
}

interface ProjectionRuntime {
  readonly Files: new (input: {
    packageRoot: string;
    stateRoot: string;
    faultInjector?: (point: string) => void;
  }) => ProjectionFiles;
  readonly Projector: new (input: {
    store: ProgressStore;
    files: ProjectionFiles;
    stateRoot: string;
    faultInjector?: (point: string) => void;
  }) => Projector;
}

const repo = process.cwd();
const fixtures: ProgressFixture[] = [];
const verifierByStore = new WeakMap<object, ProgressAuthorityComposition["verifier"]>();
function newFixture(): ProgressFixture {
  const fixture = createProgressFixture();
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) removeProgressFixture(fixture);
});

async function loadBootstrapFactory(): Promise<CreateReviewedV4Bootstrap> {
  const modulePath = pathToFileURL(resolve("src/migration/reviewed-v4-bootstrap.ts")).href;
  const module = await import(modulePath);
  return module.createReviewedV4Bootstrap as CreateReviewedV4Bootstrap;
}

async function migrateFixture(fixture: ProgressFixture): Promise<void> {
  const createBootstrap = await loadBootstrapFactory();
  const authorityModule = await import(pathToFileURL(resolve("src/migration/reviewed-v4-migration-authority.ts")).href);
  const migrationAuthority = authorityModule.createReviewedV4MigrationAuthority({ stateRoot: fixture.stateRoot }) as MigrationAuthorityComposition;
  const composition = createBootstrap({
    process: {
      async run({ cwd }) {
        try {
          const coordinator = new MigrationCoordinator({
            stateDatabase: fixture.databasePath,
            historyDatabase: fixture.historyPath,
            repositoryRoot: cwd,
          });
          const result = coordinator.migrateToV4();
          coordinator.extendReviewV3SchemaOffline();
          return { status: 0, stdout: JSON.stringify(result), stderr: "" };
        } catch (error) {
          return { status: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
        }
      },
    },
    quiescence: {
      assertServiceInactive: () => undefined,
      assertNoOpenDatabaseFds: () => undefined,
      acquireExclusiveWriteFence: () => ({ assertCurrent: () => undefined, release: () => undefined }),
    },
    migrationAuthority: migrationAuthority.consumer,
  });
  const operationId = "fixture-reviewed-v4";
  const authority = migrationAuthority.issuer.issue({
    operationId,
    consumer: "codex:/root:state-v4-reviewed-bootstrap",
    scope: "reviewed-state-v4-migration",
    sourceIdentity: { commitOid: REVIEWED_COMMIT, treeOid: REVIEWED_TREE },
    stateDatabase: fixture.databasePath,
    historyDatabase: fixture.historyPath,
  });
  await composition.bootstrapReviewedV4({
    operationId,
    gitRoot: repo,
    reviewedWorktreeParent: join(fixture.root, "reviewed-worktrees"),
    sourceIdentity: { commitOid: REVIEWED_COMMIT, treeOid: REVIEWED_TREE },
    stateDatabase: fixture.databasePath,
    historyDatabase: fixture.historyPath,
  }, authority);
  migrationAuthority.close();
}

async function loadProgressRuntime(): Promise<ProgressRuntime> {
  const storePath = pathToFileURL(resolve("src/store/implementation-progress-store.ts")).href;
  const servicePath = pathToFileURL(resolve("src/app/implementation-progress-service.ts")).href;
  const [storeModule, serviceModule] = await Promise.all([import(storePath), import(servicePath)]);
  return {
    Store: storeModule.ImplementationProgressStore as ProgressRuntime["Store"],
    Service: serviceModule.ImplementationProgressService as ProgressRuntime["Service"],
  };
}

async function newProgressStore(
  runtime: ProgressRuntime,
  fixture: ProgressFixture,
  options: { faultInjector?: (point: string) => void; amendmentAuthority?: AmendmentAcceptanceAuthority } = {},
): Promise<ProgressStore> {
  const modulePath = pathToFileURL(resolve("src/flow/implementation-progress-authority.ts")).href;
  const module = await import(modulePath);
  const authority = module.createImplementationProgressAuthority() as ProgressAuthorityComposition;
  const store = new runtime.Store(fixture.databasePath, {
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
    progressAuthority: authority.store,
    ...(options.amendmentAuthority ? { amendmentAuthority: options.amendmentAuthority.store } : {}),
  });
  verifierByStore.set(store as object, authority.verifier);
  return store;
}

async function loadPureProgress(): Promise<ProgressPureRuntime> {
  const modulePath = pathToFileURL(resolve("src/flow/implementation-progress.ts")).href;
  const module = await import(modulePath);
  return {
    verifyProgressEvent: module.verifyProgressEvent as ProgressPureRuntime["verifyProgressEvent"],
    reduceImplementationProgress: module.reduceImplementationProgress as ProgressPureRuntime["reduceImplementationProgress"],
    verifyLiveProviderLaunchAccounting:
      module.verifyLiveProviderLaunchAccounting as ProgressPureRuntime["verifyLiveProviderLaunchAccounting"],
  };
}

async function loadAmendmentRuntime(): Promise<AmendmentRuntime> {
  const modulePath = pathToFileURL(resolve("src/flow/implementation-amendment.ts")).href;
  const module = await import(modulePath);
  return {
    createAmendmentAcceptanceAuthority:
      module.createAmendmentAcceptanceAuthority as AmendmentRuntime["createAmendmentAcceptanceAuthority"],
    verifyImplementationAmendment:
      module.verifyImplementationAmendment as AmendmentRuntime["verifyImplementationAmendment"],
  };
}

async function loadProjectionRuntime(): Promise<ProjectionRuntime> {
  const filesPath = pathToFileURL(resolve("src/store/implementation-progress-projection-files.ts")).href;
  const projectorPath = pathToFileURL(resolve("src/app/implementation-progress-projector.ts")).href;
  const [filesModule, projectorModule] = await Promise.all([import(filesPath), import(projectorPath)]);
  return {
    Files: filesModule.ImplementationProgressProjectionFiles as ProjectionRuntime["Files"],
    Projector: projectorModule.ImplementationProgressProjector as ProjectionRuntime["Projector"],
  };
}

function sourceFacts(fixture: ProgressFixture): {
  start: JsonObject;
  planLock: JsonObject;
  planAnchorParent: string;
} {
  return {
    start: JSON.parse(readFileSync(join(fixture.repositoryRoot, "docs/hybrid-flow-v1-r2/IMPLEMENTATION_START.json"), "utf8")) as JsonObject,
    planLock: JSON.parse(readFileSync(join(fixture.repositoryRoot, "docs/hybrid-flow-v1-r2/PLAN_LOCK.json"), "utf8")) as JsonObject,
    planAnchorParent: "d0f6cda738cf08ff851f14192ff48e636c1f0f17",
  };
}

function serviceFor(
  runtime: ProgressRuntime,
  fixture: ProgressFixture,
  store: ProgressStore,
  amendmentAuthority?: AmendmentAcceptanceAuthority,
): ProgressService {
  const packageRoot = join(fixture.repositoryRoot, "docs/hybrid-flow-v1-r2");
  return new runtime.Service({
    store,
    databasePath: fixture.databasePath,
    readArtifact: (path) => readFileSync(join(fixture.repositoryRoot, path)),
    readProjection: () => {
      const read = (name: string): Buffer | undefined => {
        try { return readFileSync(join(packageRoot, name)); } catch { return undefined; }
      };
      const jsonl = read("IMPLEMENTATION_PROGRESS.jsonl");
      const markdown = read("IMPLEMENTATION_PROGRESS.md");
      return {
        ...(jsonl ? { jsonl } : {}),
        ...(markdown ? { markdown } : {}),
      };
    },
    sourceFacts: sourceFacts(fixture),
    progressVerifier: verifierByStore.get(store as object),
    ...(amendmentAuthority ? { amendmentAuthority: amendmentAuthority.service } : {}),
  });
}

function amendmentInput(amd: AmendmentFixture): AmendmentVerificationInput {
  return {
    amendment: structuredClone(amd.amendment),
    authorityReceipt: structuredClone(amd.authorityReceipt),
    evidenceArtifacts: amd.evidenceArtifacts.map(({ path, bytes }) => ({ path, bytes: Buffer.from(bytes) })),
    authorizationTextBytes: Buffer.from(amd.authorizationTextBytes),
    acceptedAt: AMD_ACCEPTED_AT,
  };
}

function amendmentRequest(amd: AmendmentFixture): AmendmentRequest {
  return {
    amendmentPath: amd.amendmentPath,
    authorityReceiptPath: amd.authorityReceiptPath,
    authorizationTextBytes: Buffer.from(amd.authorizationTextBytes),
    acceptedAt: AMD_ACCEPTED_AT,
  };
}

function amendmentCapabilityBinding(fixture: ProgressFixture, amd: AmendmentFixture): AmendmentCapabilityBinding {
  return {
    databasePath: fixture.databasePath,
    amendmentId: "AMD-0001",
    amendmentPath: amd.amendmentPath,
    amendmentFileSha256: AMD_FILE_SHA256,
    authorityReceiptPath: amd.authorityReceiptPath,
    authorityReceiptFileSha256: AMD_AUTHORITY_RECEIPT_FILE_SHA256,
  };
}

function issuedAmendmentAuthority(
  runtime: AmendmentRuntime,
  fixture: ProgressFixture,
  amd: AmendmentFixture,
): { authority: AmendmentAcceptanceAuthority; capability: AmendmentAcceptanceCapability } {
  const authority = runtime.createAmendmentAcceptanceAuthority(amd.trustedAuthority);
  return { authority, capability: authority.issuer.issue(amendmentCapabilityBinding(fixture, amd)) };
}

function writeCanonicalDocument(fixture: ProgressFixture, path: string, value: JsonObject): void {
  writeArtifact(fixture.repositoryRoot, path, Buffer.from(`${canonicalJson(value)}\n`, "utf8"));
}

function mutateCanonicalDocument(
  fixture: ProgressFixture,
  path: string,
  mutate: (value: JsonObject) => void,
): void {
  const value = JSON.parse(readFileSync(join(fixture.repositoryRoot, path), "utf8")) as JsonObject;
  mutate(value);
  writeCanonicalDocument(fixture, path, value);
}

function forgeSelfConsistentPair(amd: AmendmentFixture): AmendmentVerificationInput {
  const proposal = structuredClone(amd.amendment);
  delete proposal.amendmentSha256;
  delete proposal.authorityReceiptSha256;
  proposal.reason = "Self-consistent replacement outside AMD-0001 authority.";
  proposal.reasonSha256 = sha256(canonicalJson(proposal.reason));
  const authorityReceipt = structuredClone(amd.authorityReceipt);
  authorityReceipt.proposalSha256 = sha256(canonicalJson(proposal));
  const receiptSha = sha256(canonicalJson(authorityReceipt));
  const amendment = withCanonicalHash({ ...proposal, authorityReceiptSha256: receiptSha }, "amendmentSha256");
  return { ...amendmentInput(amd), amendment, authorityReceipt };
}

function verifiedEvent4(pure: ProgressPureRuntime, fixture: ProgressFixture, store?: ProgressStore): VerifiedProgressEvent {
  const existingEvents = progressRows(fixture.databasePath).events.map(({ event_json }) => JSON.parse(String(event_json)) as JsonObject);
  const candidate = readR2ProgressEvent(4);
  const request = {
    existingEvents,
    candidate,
    eventJson: canonicalJson(candidate),
    artifactFacts: eventArtifactFacts(fixture.repositoryRoot, [candidate]),
    startSha256: R2_START_SHA256,
    baselinePlanSha256: R2_PLAN_SHA256,
  };
  const verifier = store ? verifierByStore.get(store as object) : undefined;
  const replay = existingEvents.some((event) => event.eventId === candidate.eventId);
  return verifier
    ? replay
      ? verifier.authorizeReplay({ storeIdentity: store!.authorityIdentity(), existingEvents, candidate, eventJson: request.eventJson })
      : verifier.authorize({ ...request, storeIdentity: store!.authorityIdentity() })
    : pure.verifyProgressEvent(request);
}

function injectProgressEvent(databasePath: string, event: JsonObject): void {
  const eventJson = canonicalJson(event);
  const db = new Database(databasePath);
  try {
    db.prepare(`INSERT INTO plan_progress_events
      (plan_id,sequence_no,event_id,start_sha256,previous_event_sha256,effective_plan_sha256,
       event_json,event_sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      event.planId, event.sequence, event.eventId, event.startSha256, event.previousEventSha256,
      event.effectivePlanSha256, eventJson, event.eventSha256, Date.parse(String(event.recordedAt)),
    );
    db.prepare(`INSERT INTO plan_progress_outbox
      (event_id,projection_payload_json,published_at,terminal_reason) VALUES (?,?,NULL,NULL)`)
      .run(event.eventId, eventJson);
  } finally { db.close(); }
}

function updateBoundArtifact(
  fixture: ProgressFixture,
  sequence: number,
  path: string,
  mutate: (value: JsonObject) => void,
): void {
  const value = JSON.parse(readFileSync(join(fixture.repositoryRoot, path), "utf8")) as JsonObject;
  mutate(value);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  writeArtifact(fixture.repositoryRoot, path, bytes);
  rewriteEventChain(fixture, sequence, (event) => rebindEventArtifact(event, path, bytes));
}

function coherentOptionalMutation(
  fixture: ProgressFixture,
  sequence: 3 | 4,
  mutate: (optional: JsonObject) => void,
): void {
  const stage = sequence === 3 ? "STG-02" : "STG-03";
  const optionalPath = `docs/hybrid-flow-v1-r2/stage-close/${stage}-optional-providers.json`;
  const barrierPath = `docs/hybrid-flow-v1-r2/stage-close/${stage}-barrier.json`;
  const oraclePath = `docs/hybrid-flow-v1-r2/stage-close/${stage}-terminal-oracle.json`;
  const optional = JSON.parse(readFileSync(join(fixture.repositoryRoot, optionalPath), "utf8")) as JsonObject;
  mutate(optional);
  const optionalBytes = Buffer.from(`${JSON.stringify(optional, null, 2)}\n`);
  writeArtifact(fixture.repositoryRoot, optionalPath, optionalBytes);

  const barrier = JSON.parse(readFileSync(join(fixture.repositoryRoot, barrierPath), "utf8")) as JsonObject;
  barrier.optionalStatusSha256 = sha256(optionalBytes);
  const optionalLanes = barrier.optionalLanes as JsonObject[];
  const providers = optional.providers as JsonObject;
  for (const lane of optionalLanes) {
    lane.status = (providers[String(lane.agent)] as JsonObject)[String(lane.role)];
  }
  const barrierBytes = Buffer.from(`${JSON.stringify(barrier, null, 2)}\n`);
  writeArtifact(fixture.repositoryRoot, barrierPath, barrierBytes);

  const oracle = JSON.parse(readFileSync(join(fixture.repositoryRoot, oraclePath), "utf8")) as JsonObject;
  const checks = oracle.checks as JsonObject;
  checks.ambiguousAttempts = optional.ambiguousLaunchedAttempts;
  const roleKey = (agent: string, role: string): string => `${agent}${role[0]!.toUpperCase()}${role.slice(1)}`;
  for (const lane of optionalLanes) checks[roleKey(String(lane.agent), String(lane.role))] = lane.status;
  const oracleBytes = Buffer.from(`${JSON.stringify(oracle, null, 2)}\n`);
  writeArtifact(fixture.repositoryRoot, oraclePath, oracleBytes);

  rewriteEventChain(fixture, sequence, (event) => {
    rebindEventArtifact(event, optionalPath, optionalBytes);
    rebindEventArtifact(event, barrierPath, barrierBytes);
    rebindEventArtifact(event, oraclePath, oracleBytes);
  });
}

describe("pure implementation amendment and progress contracts", () => {
  it("verifies the one byte-pinned AMD only against a separate external authority capability and real evidence bytes", async () => {
    const { verifyImplementationAmendment } = await loadAmendmentRuntime();
    const fixture = newFixture();
    const amd = amendmentFixture(fixture);
    assertFixturePins(amd);
    expect(amd.amendmentFileSha256).toBe(AMD_FILE_SHA256);
    expect(sha256(canonicalJson(amd.authorityReceipt))).toBe(AMD_AUTHORITY_RECEIPT_SHA256);
    expect(amd.authorityReceiptFileSha256).toBe(AMD_AUTHORITY_RECEIPT_FILE_SHA256);
    expect(amd.effectivePlanSha256).toBe(AMD_EFFECTIVE_PLAN_SHA256);
    expect(sha256(amd.authorizationTextBytes)).toBe(AMD_AUTHORIZATION_TEXT_SHA256);
    expect(amd.authorizationTextBytes.toString("utf8"))
      .toBe("разрешаю оформить и принять AMD-0001 в указанном объёме");
    expect(amd.authorizationTextBytes.at(-1)).not.toBe(0x0a);
    expect(amd.authorityReceipt.capturedAt).toBe(AMD_AUTHORIZATION_CAPTURED_AT);
    expect(amd.amendment.recordedAt).toBe(AMD_RECORDED_AT);
    expect(amd.evidenceArtifacts.map(({ path, bytes }) => ({ path, sha256: sha256(bytes) }))).toEqual([
      {
        path: "docs/hybrid-flow-v1-r2/amendments/evidence/architecture-slice.md",
        sha256: AMD_ARCHITECTURE_EVIDENCE_SHA256,
      },
      {
        path: "docs/hybrid-flow-v1-r2/amendments/evidence/stg-03-source-manifest.json",
        sha256: AMD_STG03_SOURCE_MANIFEST_SHA256,
      },
    ]);
    expect(amd.evidenceArtifacts.every(({ path, bytes }) =>
      sha256(bytes) === (amd.amendment.evidence as JsonObject[]).find((ref) => ref.path === path)?.sha256)).toBe(true);
    expect(amd.amendment).not.toHaveProperty("authorityReceipt");
    expect(amd.authorityReceipt).not.toHaveProperty("amendmentSha256");
    expect(Date.parse(String(readR2ProgressEvent(4).recordedAt)))
      .toBeLessThan(Date.parse(String(amd.authorityReceipt.capturedAt)));
    expect(Date.parse(String(amd.authorityReceipt.capturedAt)))
      .toBeLessThanOrEqual(Date.parse(String(amd.amendment.recordedAt)));
    expect(Date.parse(String(amd.amendment.recordedAt))).toBeLessThan(AMD_ACCEPTED_AT);

    const input = amendmentInput(amd);
    const before = {
      ...structuredClone(input),
      evidenceArtifacts: input.evidenceArtifacts.map(({ path, bytes }) => ({ path, bytes: Buffer.from(bytes) })),
      authorizationTextBytes: Buffer.from(input.authorizationTextBytes),
    };
    expect(verifyImplementationAmendment(input, amd.trustedAuthority)).toMatchObject({
      amendmentSha256: amd.amendment.amendmentSha256,
      authorityReceiptSha256: AMD_AUTHORITY_RECEIPT_SHA256,
      effectivePlanSha256: amd.effectivePlanSha256,
    });
    expect(input).toEqual(before);
    expect(Object.keys(input)).not.toContain("trustedAuthority");
    expect(Object.keys(input)).not.toContain("expectedReceiptSha256");
  });

  it("rejects a self-consistent forged amendment and receipt against the unchanged external trust anchor", async () => {
    const { verifyImplementationAmendment } = await loadAmendmentRuntime();
    const fixture = newFixture();
    const amd = amendmentFixture(fixture);
    const forged = forgeSelfConsistentPair(amd);
    expect(sha256(canonicalJson(forged.authorityReceipt))).not.toBe(amd.trustedAuthority.expectedReceiptSha256);
    expect(() => verifyImplementationAmendment(forged, amd.trustedAuthority))
      .toThrow(/external|trusted|authority|receipt/i);
  });

  const amendmentFields = [
    "schemaVersion", "amendmentId", "ordinal", "planId", "baselinePlanSha256",
    "previousEffectivePlanSha256", "affectedStageIds", "affectedGateIds", "reason",
    "reasonSha256", "evidence", "evidenceSha256", "contractDelta", "acceptanceDelta",
    "authorityDelta", "invalidatedEventIds", "authorityConsumer", "authorityReceiptSha256",
    "recordedAt", "amendmentSha256",
  ] as const;
  const authorityFields = [
    "schemaVersion", "planId", "amendmentId", "ordinal", "consumer",
    "affectedStageIds", "affectedGateIds", "contractDeltaSha256",
    "acceptanceDeltaSha256", "authorityDeltaSha256", "scope",
    "authorizationTextSha256", "capturedAt", "proposalSha256",
  ] as const;

  const amendmentMutations: Array<{
    name: string;
    mutate: (input: AmendmentVerificationInput) => void;
  }> = [
    ...amendmentFields.map((field) => ({
      name: `missing amendment field ${field}`,
      mutate: (input: AmendmentVerificationInput) => { delete input.amendment[field]; },
    })),
    ...authorityFields.map((field) => ({
      name: `missing authority field ${field}`,
      mutate: (input: AmendmentVerificationInput) => { delete input.authorityReceipt[field]; },
    })),
    { name: "extra amendment field", mutate: (input) => { input.amendment.untrustedExtra = true; } },
    { name: "extra authority field", mutate: (input) => { input.authorityReceipt.untrustedExtra = true; } },
    { name: "empty reason", mutate: (input) => { input.amendment.reason = ""; } },
    { name: "oversized reason", mutate: (input) => { input.amendment.reason = "x".repeat(4_097); } },
    {
      name: "unsorted stage IDs",
      mutate: (input) => { input.amendment.affectedStageIds = ["STG-08", "STG-04"]; },
    },
    {
      name: "duplicate gate IDs",
      mutate: (input) => {
        input.amendment.affectedGateIds = ["STG-04-G1", "STG-04-G1", "STG-08-G1", "STG-08-G2"];
      },
    },
    {
      name: "unsorted authority stage IDs",
      mutate: (input) => { input.authorityReceipt.affectedStageIds = ["STG-08", "STG-04"]; },
    },
    {
      name: "duplicate authority gate IDs",
      mutate: (input) => {
        input.authorityReceipt.affectedGateIds = ["STG-04-G1", "STG-04-G1", "STG-08-G1", "STG-08-G2"];
      },
    },
    {
      name: "unsorted evidence paths",
      mutate: (input) => { input.amendment.evidence = [...(input.amendment.evidence as JsonObject[])].reverse(); },
    },
    {
      name: "duplicate evidence path",
      mutate: (input) => {
        const evidence = input.amendment.evidence as JsonObject[];
        input.amendment.evidence = [evidence[0]!, structuredClone(evidence[0]!)];
      },
    },
    {
      name: "evidence path escape",
      mutate: (input) => {
        const evidence = structuredClone(input.amendment.evidence as JsonObject[]);
        evidence[0]!.path = "../../outside-authority";
        input.amendment.evidence = evidence;
      },
    },
    { name: "reason digest", mutate: (input) => { input.amendment.reasonSha256 = "0".repeat(64); } },
    { name: "evidence digest", mutate: (input) => { input.amendment.evidenceSha256 = "0".repeat(64); } },
    { name: "amendment digest", mutate: (input) => { input.amendment.amendmentSha256 = "0".repeat(64); } },
    { name: "authority receipt digest", mutate: (input) => { input.amendment.authorityReceiptSha256 = "0".repeat(64); } },
    {
      name: "contract delta expansion",
      mutate: (input) => {
        const delta = structuredClone(AMD_CONTRACT_DELTA) as unknown as JsonObject;
        ((delta["STG-04"] as JsonObject).add as string[]).push("production_execution_wiring");
        input.amendment.contractDelta = delta;
      },
    },
    {
      name: "acceptance text variant",
      mutate: (input) => {
        const delta = structuredClone(AMD_ACCEPTANCE_DELTA) as unknown as JsonObject;
        ((delta.replace as JsonObject[])[0]!).to = "Semantically similar but not the exact accepted text.";
        input.amendment.acceptanceDelta = delta;
      },
    },
    {
      name: "graph activation authority",
      mutate: (input) => {
        input.amendment.authorityDelta = { ...AMD_AUTHORITY_DELTA, graphActivation: "authorized" };
      },
    },
    {
      name: "receipt proposal digest",
      mutate: (input) => { input.authorityReceipt.proposalSha256 = "0".repeat(64); },
    },
    {
      name: "receipt contract digest",
      mutate: (input) => { input.authorityReceipt.contractDeltaSha256 = "0".repeat(64); },
    },
    {
      name: "receipt acceptance digest",
      mutate: (input) => { input.authorityReceipt.acceptanceDeltaSha256 = "0".repeat(64); },
    },
    {
      name: "receipt authority digest",
      mutate: (input) => { input.authorityReceipt.authorityDeltaSha256 = "0".repeat(64); },
    },
    {
      name: "authorization text bytes",
      mutate: (input) => { input.authorizationTextBytes = Buffer.from("different authorization\n"); },
    },
    {
      name: "first evidence bytes",
      mutate: (input) => {
        input.evidenceArtifacts = input.evidenceArtifacts.map((artifact, index) => index === 0
          ? { ...artifact, bytes: Buffer.from("changed evidence\n") }
          : artifact);
      },
    },
    {
      name: "missing evidence artifact",
      mutate: (input) => { input.evidenceArtifacts = input.evidenceArtifacts.slice(1); },
    },
    {
      name: "acceptance before amendment recording",
      mutate: (input) => { input.acceptedAt = Date.parse("2026-09-04T15:59:59+08:00"); },
    },
  ];

  it.each(amendmentMutations)("rejects exact AMD mutation: $name", async ({ mutate }) => {
    const { verifyImplementationAmendment } = await loadAmendmentRuntime();
    const fixture = newFixture();
    const amd = amendmentFixture(fixture);
    const attacked = amendmentInput(amd);
    mutate(attacked);
    expect(() => verifyImplementationAmendment(attacked, amd.trustedAuthority))
      .toThrow(/AMD|amendment|authority|digest|hash|evidence|chronology|field|allowlist|scope/i);
  });

  it("separates the historical 40/40 receipt from the immutable post-start 24-launch authority", async () => {
    const pure = await loadPureProgress();
    const fixture = newFixture();
    const implementationStart = sourceFacts(fixture).start;
    const events = [1, 2, 3, 4].map(readR2ProgressEvent);
    const artifactFacts = eventArtifactFacts(fixture.repositoryRoot, events);

    expect(pure.verifyLiveProviderLaunchAccounting({
      implementationStart,
      events,
      artifactFacts,
    })).toEqual({
      historical: {
        recordedCap: 40,
        consumed: 40,
        legacyNullDerivedZero: [
          "r2-stg-00-pass@ca0e9dbd810ab6ed41c8b25c760b71d5bee8c621b60d3895fc778634e63c0bd7",
          "stg-01-pass@98e901f40784a4b7d2bba23847b80e491f808eb710e14f9ce2fc59f070bb8b97",
        ],
      },
      postStart: {
        cap: 24,
        consumed: 0,
        remaining: 24,
        costCapUsd: 10,
        costConsumedUsd: 0,
        costRemainingUsd: 10,
      },
    });
    expect(() => pure.verifyLiveProviderLaunchAccounting({
      implementationStart: { ...implementationStart, liveProviderScope: "max_40_launches_usd_10" },
      events,
      artifactFacts,
    })).toThrow(/start|scope|24|authority|cap/i);
  });

  it("reduces epochs and nonempty invalidation transitively without mutating old rows or restoring checkboxes", async () => {
    const pure = await loadPureProgress();
    const fixture = newFixture();
    const baseline = [1, 2, 3, 4].map(readR2ProgressEvent);
    const oldRows = structuredClone(baseline);
    const newEpoch = "4".repeat(64);
    const accepted = withCanonicalHash({
      schemaVersion: "PlanProgressEvent/v1",
      eventId: "synthetic-amendment-accepted",
      sequence: 5,
      previousEventSha256: baseline[3]!.eventSha256,
      startSha256: R2_START_SHA256,
      eventType: "amendment_accepted",
      planId: R2_PLAN_ID,
      effectivePlanSha256: newEpoch,
      previousEffectivePlanSha256: R2_PLAN_SHA256,
      amendmentSha256: "5".repeat(64),
      authorityReceiptSha256: "6".repeat(64),
      invalidatedEventIds: ["stg-02-pass"],
      recordedAt: "2026-09-04T17:00:00+08:00",
    }, "eventSha256");
    const eligible = withCanonicalHash({
      schemaVersion: "PlanProgressEvent/v1",
      eventId: "synthetic-stg-02-eligible",
      sequence: 6,
      previousEventSha256: accepted.eventSha256,
      startSha256: R2_START_SHA256,
      eventType: "step_eligible",
      planId: R2_PLAN_ID,
      effectivePlanSha256: newEpoch,
      stageId: "STG-02",
      recordedAt: "2026-09-04T17:01:00+08:00",
    }, "eventSha256");
    const reduced = pure.reduceImplementationProgress({
      events: [...baseline, accepted, eligible],
      startSha256: R2_START_SHA256,
      baselinePlanSha256: R2_PLAN_SHA256,
      artifactFacts: eventArtifactFacts(fixture.repositoryRoot, baseline),
    });
    expect(reduced).toMatchObject({ effectivePlanSha256: newEpoch });
    expect(reduced.invalidatedEventIds).toEqual(expect.arrayContaining(["stg-02-pass", "stg-03-pass"]));
    expect(reduced.completedStageIds).not.toEqual(expect.arrayContaining(["STG-02", "STG-03"]));
    expect(reduced.eligibleStageIds).toContain("STG-02");
    expect(baseline).toEqual(oldRows);

    const stale = withCanonicalHash({
      ...eligible,
      eventId: "stale-old-epoch-close",
      sequence: 7,
      previousEventSha256: eligible.eventSha256,
      eventType: "step_completed",
      effectivePlanSha256: R2_PLAN_SHA256,
      terminalResult: "PASS",
    }, "eventSha256");
    expect(() => pure.reduceImplementationProgress({
      events: [...baseline, accepted, eligible, stale],
      startSha256: R2_START_SHA256,
      baselinePlanSha256: R2_PLAN_SHA256,
      artifactFacts: eventArtifactFacts(fixture.repositoryRoot, baseline),
    })).toThrow(/epoch|effective plan|stale/i);
  });
});

describe("SQL-only implementation progress store", () => {
  it("rejects a structurally self-consistent event that has no store-bound verification authority", async () => {
    const [runtime, pure] = await Promise.all([loadProgressRuntime(), loadPureProgress()]);
    const fixture = newFixture();
    await migrateFixture(fixture);
    const store = await newProgressStore(runtime, fixture);
    store.appendVerifiedEvent(verifiedEvent4(pure, fixture, store));
    const snapshot = store.snapshotProjection();
    const forged = withCanonicalHash({
      schemaVersion: "PlanProgressEvent/v1",
      eventId: "structural-forged-stg-04-eligible",
      sequence: 5,
      previousEventSha256: snapshot.watermarkEventSha256,
      startSha256: R2_START_SHA256,
      eventType: "step_eligible",
      planId: R2_PLAN_ID,
      effectivePlanSha256: R2_PLAN_SHA256,
      stageId: "STG-04",
      recordedAt: new Date(AMD_ACCEPTED_AT).toISOString(),
    }, "eventSha256");
    const before = progressTableSnapshot(fixture.databasePath);

    expect(() => store.appendVerifiedEvent({
      event: forged,
      eventJson: canonicalJson(forged),
      eventSha256: String(forged.eventSha256),
    })).toThrow(/authority|attest|verified|capability/i);
    expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
    store.close();
  });

  it("rejects a verified amendment object that has no store-bound acceptance capability", async () => {
    const [runtime, pure, amendmentRuntime] = await Promise.all([
      loadProgressRuntime(),
      loadPureProgress(),
      loadAmendmentRuntime(),
    ]);
    const fixture = newFixture();
    await migrateFixture(fixture);
    const amd = amendmentFixture(fixture);
    const authority = amendmentRuntime.createAmendmentAcceptanceAuthority(amd.trustedAuthority);
    const store = await newProgressStore(runtime, fixture, { amendmentAuthority: authority });
    store.appendVerifiedEvent(verifiedEvent4(pure, fixture, store));
    const verifiedAmendment = amendmentRuntime.verifyImplementationAmendment(
      amendmentInput(amd),
      amd.trustedAuthority,
    );
    const before = progressTableSnapshot(fixture.databasePath);

    expect(() => store.acceptVerifiedAmendment({
      verifiedAmendment,
      acceptedAt: AMD_ACCEPTED_AT,
    })).toThrow(/authority|acceptance|capability|attest/i);
    expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
    store.close();
  });

  it("binds a one-use progress authorization to one exact store and canonical body", async () => {
    const [runtime, pure] = await Promise.all([loadProgressRuntime(), loadPureProgress()]);
    const fixture = newFixture();
    await migrateFixture(fixture);
    const first = await newProgressStore(runtime, fixture);
    const second = await newProgressStore(runtime, fixture);
    const authorized = verifiedEvent4(pure, fixture, first);
    const cloned = Object.freeze({ ...authorized }) as VerifiedProgressEvent;

    expect(() => second.appendVerifiedEvent(authorized)).toThrow(/authority|store|attest|capability/i);
    expect(() => first.appendVerifiedEvent(cloned)).toThrow(/authority|store|attest|capability/i);
    expect(first.appendVerifiedEvent(authorized)).toMatchObject({ replayed: false, sequence: 4 });
    expect(() => first.appendVerifiedEvent(authorized)).toThrow(/claimed|consumed|authority/i);

    const freshReplay = verifiedEvent4(pure, fixture, first);
    expect(first.appendVerifiedEvent(freshReplay)).toMatchObject({ replayed: true, sequence: 4 });
    expect(progressRows(fixture.databasePath).events).toHaveLength(4);
    first.close();
    second.close();
  });

  it("serializes two preverified writers as one insert plus one exact replay", async () => {
    const [runtime, pure] = await Promise.all([loadProgressRuntime(), loadPureProgress()]);
    const fixture = newFixture();
    await migrateFixture(fixture);
    const first = await newProgressStore(runtime, fixture);
    const second = await newProgressStore(runtime, fixture);
    const firstAuthorization = verifiedEvent4(pure, fixture, first);
    const secondAuthorization = verifiedEvent4(pure, fixture, second);

    expect(first.appendVerifiedEvent(firstAuthorization)).toMatchObject({ replayed: false });
    expect(second.appendVerifiedEvent(secondAuthorization)).toMatchObject({ replayed: true });
    expect(progressRows(fixture.databasePath).events).toHaveLength(4);
    first.close();
    second.close();
  });

  it("appends sequence 4 and outbox atomically from the reviewed migration, replays exactly, and conflicts on changed bytes", async () => {
    const [runtime, pure] = await Promise.all([loadProgressRuntime(), loadPureProgress()]);
    const fixture = newFixture();
    await migrateFixture(fixture);
    let store = await newProgressStore(runtime, fixture);
    let verified = verifiedEvent4(pure, fixture, store);
    expect(store.appendVerifiedEvent(verified)).toEqual({ eventId: "stg-03-pass", sequence: 4, replayed: false });
    const committed = progressRows(fixture.databasePath);
    expect(committed.events).toHaveLength(4);
    expect(committed.outbox).toHaveLength(4);
    for (const [index, row] of committed.events.entries()) {
      const event = JSON.parse(String(row.event_json)) as JsonObject;
      expect(row).toMatchObject({
        plan_id: event.planId,
        sequence_no: index + 1,
        event_id: event.eventId,
        start_sha256: event.startSha256,
        previous_event_sha256: event.previousEventSha256,
        effective_plan_sha256: event.effectivePlanSha256,
        event_sha256: event.eventSha256,
        created_at: Date.parse(String(event.recordedAt)),
      });
      expect(committed.outbox[index]).toMatchObject({
        event_id: event.eventId,
        projection_payload_json: row.event_json,
        published_at: null,
      });
    }
    expect(committed.events[3]).toMatchObject({ event_sha256: STG03_EVENT_SHA256 });
    verified = verifiedEvent4(pure, fixture, store);
    expect(store.appendVerifiedEvent(verified)).toMatchObject({ replayed: true });
    expect(progressRows(fixture.databasePath)).toEqual(committed);

    const changedEvent = withCanonicalHash({ ...verified.event, actor: "codex:/changed-replay" }, "eventSha256");
    expect(() => store.appendVerifiedEvent({
      event: changedEvent,
      eventJson: canonicalJson(changedEvent),
      eventSha256: String(changedEvent.eventSha256),
    })).toThrow(/conflict|immutable|replay/i);
    expect(progressRows(fixture.databasePath)).toEqual(committed);
    store.close();

    store = await newProgressStore(runtime, fixture);
    verified = verifiedEvent4(pure, fixture, store);
    expect(store.appendVerifiedEvent(verified)).toMatchObject({ replayed: true });
    expect(progressRows(fixture.databasePath)).toEqual(committed);
    store.close();
  });

  it("makes transaction-aware issued-access and standalone append wrappers observationally equivalent", async () => {
    const [runtime, pure] = await Promise.all([loadProgressRuntime(), loadPureProgress()]);
    const standalone = newFixture();
    const joined = newFixture();
    await migrateFixture(standalone);
    await migrateFixture(joined);
    const standaloneStore = await newProgressStore(runtime, standalone);
    const joinedStore = await newProgressStore(runtime, joined);
    const standaloneResult = standaloneStore.appendVerifiedEvent(verifiedEvent4(pure, standalone, standaloneStore));
    const joinedResult = joinedStore.appendVerifiedEventsAtomically([verifiedEvent4(pure, joined, joinedStore)]);
    expect(joinedResult).toEqual(standaloneResult);
    expect(progressRows(joined.databasePath)).toEqual(progressRows(standalone.databasePath));
    standaloneStore.close();
    joinedStore.close();
  });

  const predecessorAttacks: Array<{
    name: string;
    sql: string;
    args?: readonly unknown[];
  }> = [
    ...[1, 2, 3].flatMap((sequence) => [
    { name: `event projection at row ${sequence}`, sql: `UPDATE plan_progress_events SET event_json='{}' WHERE sequence_no=${sequence}` },
    { name: `plan root at row ${sequence}`, sql: `UPDATE plan_progress_events SET plan_id='wrong-plan' WHERE sequence_no=${sequence}` },
    { name: `start root at row ${sequence}`, sql: `UPDATE plan_progress_events SET start_sha256=? WHERE sequence_no=${sequence}`, args: ["0".repeat(64)] },
    { name: `previous root at row ${sequence}`, sql: `UPDATE plan_progress_events SET previous_event_sha256=? WHERE sequence_no=${sequence}`, args: ["0".repeat(64)] },
    { name: `effective root at row ${sequence}`, sql: `UPDATE plan_progress_events SET effective_plan_sha256=? WHERE sequence_no=${sequence}`, args: ["0".repeat(64)] },
    { name: `event hash at row ${sequence}`, sql: `UPDATE plan_progress_events SET event_sha256=? WHERE sequence_no=${sequence}`, args: ["0".repeat(64)] },
    { name: `outbox projection at row ${sequence}`, sql: `UPDATE plan_progress_outbox SET projection_payload_json='{}' WHERE rowid=(SELECT rowid FROM plan_progress_outbox ORDER BY rowid LIMIT 1 OFFSET ${sequence - 1})` },
    ]),
    { name: "event identity", sql: "UPDATE plan_progress_events SET event_id='poisoned-event' WHERE sequence_no=2" },
    { name: "sequence gap", sql: "UPDATE plan_progress_events SET sequence_no=9 WHERE sequence_no=3" },
  ];

  it.each(predecessorAttacks)("blocks sequence 4 when a migrated predecessor has poisoned $name", async ({ sql, args = [] }) => {
    const [runtime, pure] = await Promise.all([loadProgressRuntime(), loadPureProgress()]);
    const fixture = newFixture();
    await migrateFixture(fixture);
    const verified = verifiedEvent4(pure, fixture);
    const db = new Database(fixture.databasePath);
    try {
      db.pragma("foreign_keys = OFF");
      db.prepare(sql).run(...args);
    } finally {
      db.close();
    }
    const before = progressTableSnapshot(fixture.databasePath);
    const store = await newProgressStore(runtime, fixture);
    expect(() => store.appendVerifiedEvent(verified))
      .toThrow(/chain|predecessor|projection|outbox|integrity|root|hash|gap|poison/i);
    store.close();
    expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
  });

  it("rejects an extra predecessor and a missing predecessor outbox before append", async () => {
    const [runtime, pure] = await Promise.all([loadProgressRuntime(), loadPureProgress()]);
    const missingOutbox = newFixture();
    await migrateFixture(missingOutbox);
    const missingVerified = verifiedEvent4(pure, missingOutbox);
    let db = new Database(missingOutbox.databasePath);
    db.prepare("DELETE FROM plan_progress_outbox WHERE event_id='stg-02-pass'").run();
    db.close();
    let before = progressTableSnapshot(missingOutbox.databasePath);
    let store = await newProgressStore(runtime, missingOutbox);
    expect(() => store.appendVerifiedEvent(missingVerified)).toThrow(/outbox|projection|predecessor/i);
    store.close();
    expect(progressTableSnapshot(missingOutbox.databasePath)).toBe(before);

    const extra = newFixture();
    await migrateFixture(extra);
    const extraVerified = verifiedEvent4(pure, extra);
    const unexpected = withCanonicalHash({
      ...readR2ProgressEvent(4),
      eventId: "unexpected-sequence-four",
      actor: "attacker",
    }, "eventSha256");
    db = new Database(extra.databasePath);
    db.prepare(`INSERT INTO plan_progress_events
      (plan_id,sequence_no,event_id,start_sha256,previous_event_sha256,effective_plan_sha256,
       event_json,event_sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      unexpected.planId, 4, unexpected.eventId, unexpected.startSha256,
      unexpected.previousEventSha256, unexpected.effectivePlanSha256,
      canonicalJson(unexpected), unexpected.eventSha256, Date.parse(String(unexpected.recordedAt)),
    );
    db.close();
    before = progressTableSnapshot(extra.databasePath);
    store = await newProgressStore(runtime, extra);
    expect(() => store.appendVerifiedEvent(extraVerified)).toThrow(/sequence|conflict|predecessor/i);
    store.close();
    expect(progressTableSnapshot(extra.databasePath)).toBe(before);
  });

  it.each(["after_progress_event_insert", "after_progress_outbox_insert"])(
    "reopens with all-or-none state after %s crash",
    async (faultPoint) => {
      const [runtime, pure] = await Promise.all([loadProgressRuntime(), loadPureProgress()]);
      const fixture = newFixture();
      await migrateFixture(fixture);
      const before = progressTableSnapshot(fixture.databasePath);
      let store = await newProgressStore(runtime, fixture, {
        faultInjector: (point) => {
          if (point === faultPoint) throw new Error(`injected ${faultPoint}`);
        },
      });
      expect(() => store.appendVerifiedEvent(verifiedEvent4(pure, fixture, store))).toThrow(new RegExp(faultPoint));
      store.close();
      expect(progressTableSnapshot(fixture.databasePath)).toBe(before);

      store = await newProgressStore(runtime, fixture);
      expect(store.appendVerifiedEvent(verifiedEvent4(pure, fixture, store))).toMatchObject({ sequence: 4, replayed: false });
      store.close();
      const reopened = progressRows(fixture.databasePath);
      expect(reopened.events).toHaveLength(4);
      expect(reopened.outbox).toHaveLength(4);
      expect(reopened.events[3]).toMatchObject({ event_sha256: STG03_EVENT_SHA256 });
    },
  );
});

async function readyProgressService(
  runtime: ProgressRuntime,
  fixture: ProgressFixture,
  amendmentAuthority?: AmendmentAcceptanceAuthority,
): Promise<{
  store: ProgressStore;
  service: ProgressService;
}> {
  await migrateFixture(fixture);
  const store = await newProgressStore(runtime, fixture, {
    ...(amendmentAuthority ? { amendmentAuthority } : {}),
  });
  const service = serviceFor(runtime, fixture, store, amendmentAuthority);
  const event = readR2ProgressEvent(4);
  expect(service.appendEvent({ event, eventJson: canonicalJson(event) })).toMatchObject({
    eventId: "stg-03-pass",
    sequence: 4,
    replayed: false,
  });
  return { store, service };
}

describe("implementation progress application service", () => {
  it("exposes disjoint amendment issuer, service-verifier, and store-consumer ports", async () => {
    const amendmentRuntime = await loadAmendmentRuntime();
    const fixture = newFixture();
    const authority = amendmentRuntime.createAmendmentAcceptanceAuthority(amendmentFixture(fixture).trustedAuthority);
    expect(Object.keys(authority).sort()).toEqual(["issuer", "service", "store"]);
    expect(authority.issuer).toHaveProperty("issue");
    expect(authority.issuer).not.toHaveProperty("authorize");
    expect(authority.service).not.toHaveProperty("issue");
    expect(authority.service).not.toHaveProperty("claim");
    expect(authority.store).not.toHaveProperty("issue");
    expect(authority.store).not.toHaveProperty("verifyPersisted");
  });

  it("accepts exact AMD-0001 and emits only acceptance plus STG-04 eligibility atomically and idempotently", async () => {
    const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
    const fixture = newFixture();
    const amd = amendmentFixture(fixture);
    const { authority, capability } = issuedAmendmentAuthority(amendmentRuntime, fixture, amd);
    const { store, service } = await readyProgressService(runtime, fixture, authority);
    expect(readFileSync(join(fixture.repositoryRoot, amd.amendmentPath))).toEqual(amd.amendmentBytes);
    expect(readFileSync(join(fixture.repositoryRoot, amd.authorityReceiptPath))).toEqual(amd.authorityReceiptBytes);
    expect(service.acceptAmendment(amendmentRequest(amd), capability)).toEqual({
      effectivePlanSha256: amd.effectivePlanSha256,
      replayed: false,
    });
    const committed = progressRows(fixture.databasePath);
    expect(committed.events).toHaveLength(6);
    expect(committed.outbox).toHaveLength(6);
    const accepted = JSON.parse(String(committed.events[4]!.event_json)) as JsonObject;
    const eligible = JSON.parse(String(committed.events[5]!.event_json)) as JsonObject;
    expect(accepted).toMatchObject({
      sequence: 5,
      eventType: "amendment_accepted",
      effectivePlanSha256: amd.effectivePlanSha256,
      amendmentSha256: amd.amendment.amendmentSha256,
      authorityReceiptSha256: AMD_AUTHORITY_RECEIPT_SHA256,
      authorityReceipt: amd.authorityReceipt,
      invalidatedEventIds: [],
    });
    expect(eligible).toMatchObject({
      sequence: 6,
      eventType: "step_eligible",
      stageId: "STG-04",
      effectivePlanSha256: amd.effectivePlanSha256,
    });
    expect(committed.events.map(({ event_json }) => JSON.parse(String(event_json)) as JsonObject))
      .not.toContainEqual(expect.objectContaining({ eventType: "step_eligible", stageId: "STG-08" }));
    expect(committed.events.slice(4).map(({ event_json }) =>
      (JSON.parse(String(event_json)) as JsonObject).eventType)).toEqual(["amendment_accepted", "step_eligible"]);
    expect(committed.outbox.map(({ projection_payload_json }) => projection_payload_json))
      .toEqual(committed.events.map(({ event_json }) => event_json));
    expect(accepted.previousEventSha256).toBe(committed.events[3]!.event_sha256);
    expect(eligible.previousEventSha256).toBe(committed.events[4]!.event_sha256);
    expect(amd.effectivePlanSha256).toBe(AMD_EFFECTIVE_PLAN_SHA256);
    expect(service.acceptAmendment(amendmentRequest(amd), capability)).toMatchObject({ replayed: true });
    expect(progressRows(fixture.databasePath)).toEqual(committed);
    store.close();

    const reopenedStore = await newProgressStore(runtime, fixture);
    const reopened = serviceFor(runtime, fixture, reopenedStore, authority).verify();
    expect(reopened).toMatchObject({
      status: "verified",
      authority: "sqlite",
      progressEventCount: 6,
      lastEventSha256: committed.events[5]!.event_sha256,
      effectivePlanSha256: AMD_EFFECTIVE_PLAN_SHA256,
      invalidatedEventIds: [],
      launchAccounting: {
        historical: {
          recordedCap: 40,
          consumed: 40,
          legacyNullDerivedZero: [
            "r2-stg-00-pass@ca0e9dbd810ab6ed41c8b25c760b71d5bee8c621b60d3895fc778634e63c0bd7",
            "stg-01-pass@98e901f40784a4b7d2bba23847b80e491f808eb710e14f9ce2fc59f070bb8b97",
          ],
        },
        postStart: { cap: 24, consumed: 0, remaining: 24 },
      },
    });
    reopenedStore.close();
  });

  const zeroWriteAmendmentCases: Array<{
    name: string;
    mutate: (request: AmendmentRequest, amd: AmendmentFixture, fixture: ProgressFixture) => void;
  }> = [
    {
      name: "self-consistent forged pair against unchanged authority",
      mutate: (_request, amd, fixture) => {
        const forged = forgeSelfConsistentPair(amd);
        writeCanonicalDocument(fixture, amd.amendmentPath, forged.amendment);
        writeCanonicalDocument(fixture, amd.authorityReceiptPath, forged.authorityReceipt);
      },
    },
    {
      name: "evidence path escape",
      mutate: (_request, amd, fixture) => {
        mutateCanonicalDocument(fixture, amd.amendmentPath, (amendment) => {
          const evidence = structuredClone(amendment.evidence as JsonObject[]);
          evidence[0]!.path = "../../outside-authority";
          amendment.evidence = evidence;
        });
      },
    },
    {
      name: "missing exact amendment key",
      mutate: (_request, amd, fixture) => {
        mutateCanonicalDocument(fixture, amd.amendmentPath, (amendment) => { delete amendment.reason; });
      },
    },
    {
      name: "broadened contract delta",
      mutate: (_request, amd, fixture) => {
        mutateCanonicalDocument(fixture, amd.amendmentPath, (amendment) => {
          const delta = structuredClone(AMD_CONTRACT_DELTA) as unknown as JsonObject;
          ((delta["STG-04"] as JsonObject).add as string[]).push("runstore_execution_wiring");
          amendment.contractDelta = delta;
        });
      },
    },
    {
      name: "graph activation right",
      mutate: (_request, amd, fixture) => {
        mutateCanonicalDocument(fixture, amd.amendmentPath, (amendment) => {
          amendment.authorityDelta = { ...AMD_AUTHORITY_DELTA, graphActivation: "authorized" };
        });
      },
    },
    {
      name: "stale previous epoch",
      mutate: (_request, amd, fixture) => {
        mutateCanonicalDocument(fixture, amd.amendmentPath, (amendment) => {
          amendment.previousEffectivePlanSha256 = "0".repeat(64);
        });
      },
    },
    {
      name: "stale chain binding",
      mutate: (_request, amd, fixture) => {
        mutateCanonicalDocument(fixture, amd.amendmentPath, (amendment) => {
          amendment.baselinePlanSha256 = "0".repeat(64);
        });
      },
    },
    {
      name: "changed authority receipt",
      mutate: (_request, amd, fixture) => {
        mutateCanonicalDocument(fixture, amd.authorityReceiptPath, (receipt) => { receipt.consumer = "attacker"; });
      },
    },
    {
      name: "missing canonical amendment file",
      mutate: (_request, amd, fixture) => {
        rmSync(join(fixture.repositoryRoot, amd.amendmentPath));
      },
    },
    {
      name: "noncanonical amendment file bytes",
      mutate: (_request, amd, fixture) => {
        writeArtifact(fixture.repositoryRoot, amd.amendmentPath, Buffer.concat([amd.amendmentBytes, Buffer.from("\n")]));
      },
    },
    {
      name: "missing canonical authority receipt file",
      mutate: (_request, amd, fixture) => {
        rmSync(join(fixture.repositoryRoot, amd.authorityReceiptPath));
      },
    },
    {
      name: "noncanonical authority receipt file bytes",
      mutate: (_request, amd, fixture) => {
        writeArtifact(
          fixture.repositoryRoot,
          amd.authorityReceiptPath,
          Buffer.concat([amd.authorityReceiptBytes, Buffer.from("\n")]),
        );
      },
    },
    {
      name: "unbound amendment request path",
      mutate: (request) => { request.amendmentPath = "docs/hybrid-flow-v1-r2/amendments/other.json"; },
    },
    {
      name: "unbound authority request path",
      mutate: (request) => { request.authorityReceiptPath = "docs/hybrid-flow-v1-r2/amendments/other-authority.json"; },
    },
    {
      name: "changed authorization bytes",
      mutate: (request) => { request.authorizationTextBytes = Buffer.from("разрешаю"); },
    },
    {
      name: "missing evidence artifact",
      mutate: (_request, amd, fixture) => {
        const path = (amd.amendment.evidence as JsonObject[])[0]!.path;
        rmSync(join(fixture.repositoryRoot, String(path)));
      },
    },
    {
      name: "modified evidence artifact",
      mutate: (_request, amd, fixture) => {
        const path = (amd.amendment.evidence as JsonObject[])[0]!.path;
        writeFileSync(join(fixture.repositoryRoot, String(path)), "modified\n");
      },
    },
    {
      name: "acceptance chronology",
      mutate: (request) => { request.acceptedAt = Date.parse("2026-09-04T15:59:00+08:00"); },
    },
  ];

  it.each(zeroWriteAmendmentCases)("rejects $name with exact event/outbox zero-write", async ({ mutate }) => {
    const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
    const fixture = newFixture();
    const amd = amendmentFixture(fixture);
    const { authority, capability } = issuedAmendmentAuthority(amendmentRuntime, fixture, amd);
    const { store, service } = await readyProgressService(runtime, fixture, authority);
    const request = amendmentRequest(amd);
    mutate(request, amd, fixture);
    const before = progressTableSnapshot(fixture.databasePath);
    expect(() => service.acceptAmendment(request, capability))
      .toThrow(/AMD|amendment|authority|scope|epoch|chain|artifact|evidence|chronology|digest|hash|field|file|canonical|missing/i);
    expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
    store.close();
  });

  it.each(["missing", "structural clone", "foreign issuer"] as const)(
    "rejects a %s amendment capability before filesystem or SQLite effects",
    async (variant) => {
      const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
      const fixture = newFixture();
      const amd = amendmentFixture(fixture);
      const issued = issuedAmendmentAuthority(amendmentRuntime, fixture, amd);
      const { store, service } = await readyProgressService(runtime, fixture, issued.authority);
      const candidate = variant === "missing"
        ? undefined as unknown as AmendmentAcceptanceCapability
        : variant === "structural clone"
          ? Object.freeze({ ...issued.capability }) as unknown as AmendmentAcceptanceCapability
          : issuedAmendmentAuthority(amendmentRuntime, fixture, amd).capability;
      const beforeDatabase = progressTableSnapshot(fixture.databasePath);
      const beforeAmendment = readFileSync(join(fixture.repositoryRoot, amd.amendmentPath));
      const beforeAuthority = readFileSync(join(fixture.repositoryRoot, amd.authorityReceiptPath));
      expect(() => service.acceptAmendment(amendmentRequest(amd), candidate))
        .toThrow(/amendment authority|issuer|capability|identity|required/i);
      expect(progressTableSnapshot(fixture.databasePath)).toBe(beforeDatabase);
      expect(readFileSync(join(fixture.repositoryRoot, amd.amendmentPath))).toEqual(beforeAmendment);
      expect(readFileSync(join(fixture.repositoryRoot, amd.authorityReceiptPath))).toEqual(beforeAuthority);
      store.close();
    },
  );

  it("rejects a genuine amendment capability rebound to another SQLite target", async () => {
    const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
    const authorizedFixture = newFixture();
    const reboundFixture = newFixture();
    const authorizedAmd = amendmentFixture(authorizedFixture);
    const reboundAmd = amendmentFixture(reboundFixture);
    const issued = issuedAmendmentAuthority(amendmentRuntime, authorizedFixture, authorizedAmd);
    const { store, service } = await readyProgressService(runtime, reboundFixture, issued.authority);
    const authorizedBefore = sqliteSnapshot(authorizedFixture.databasePath);
    const reboundBefore = progressTableSnapshot(reboundFixture.databasePath);
    const reboundAmendmentBefore = readFileSync(join(reboundFixture.repositoryRoot, reboundAmd.amendmentPath));
    const reboundAuthorityBefore = readFileSync(join(reboundFixture.repositoryRoot, reboundAmd.authorityReceiptPath));

    expect(() => service.acceptAmendment(amendmentRequest(reboundAmd), issued.capability))
      .toThrow(/amendment authority|capability|binding|database|target/i);
    expect(sqliteSnapshot(authorizedFixture.databasePath)).toEqual(authorizedBefore);
    expect(progressTableSnapshot(reboundFixture.databasePath)).toBe(reboundBefore);
    expect(readFileSync(join(reboundFixture.repositoryRoot, reboundAmd.amendmentPath)))
      .toEqual(reboundAmendmentBefore);
    expect(readFileSync(join(reboundFixture.repositoryRoot, reboundAmd.authorityReceiptPath)))
      .toEqual(reboundAuthorityBefore);
    store.close();
  });

  it("conflicts on reused ordinal/authority with changed bytes while exact replay remains zero-write", async () => {
    const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
    const fixture = newFixture();
    const amd = amendmentFixture(fixture);
    const { authority, capability } = issuedAmendmentAuthority(amendmentRuntime, fixture, amd);
    const { store, service } = await readyProgressService(runtime, fixture, authority);
    service.acceptAmendment(amendmentRequest(amd), capability);
    const committed = progressTableSnapshot(fixture.databasePath);
    expect(service.acceptAmendment(amendmentRequest(amd), capability)).toMatchObject({ replayed: true });
    expect(progressTableSnapshot(fixture.databasePath)).toBe(committed);

    const forged = forgeSelfConsistentPair(amd);
    writeCanonicalDocument(fixture, amd.amendmentPath, forged.amendment);
    writeCanonicalDocument(fixture, amd.authorityReceiptPath, forged.authorityReceipt);
    expect(() => service.acceptAmendment(amendmentRequest(amd), capability))
      .toThrow(/ordinal|authority|conflict|AMD|allowlist|digest|hash|capability/i);
    expect(progressTableSnapshot(fixture.databasePath)).toBe(committed);
    store.close();
  });

  it.each(["after_amendment_acceptance_event", "after_step_eligible_event", "after_progress_outbox_insert"])(
    "rolls back both AMD events and outbox rows after %s fault and reopens cleanly",
    async (faultPoint) => {
      const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
      const fixture = newFixture();
      const amd = amendmentFixture(fixture);
      const { authority, capability } = issuedAmendmentAuthority(amendmentRuntime, fixture, amd);
      await migrateFixture(fixture);
      let store = await newProgressStore(runtime, fixture, { amendmentAuthority: authority });
      let service = serviceFor(runtime, fixture, store, authority);
      const event = readR2ProgressEvent(4);
      service.appendEvent({ event, eventJson: canonicalJson(event) });
      store.close();
      const before = progressTableSnapshot(fixture.databasePath);

      store = await newProgressStore(runtime, fixture, {
        faultInjector: (point) => {
          if (point === faultPoint) throw new Error(`injected ${faultPoint}`);
        },
        amendmentAuthority: authority,
      });
      service = serviceFor(runtime, fixture, store, authority);
      expect(() => service.acceptAmendment(amendmentRequest(amd), capability)).toThrow(new RegExp(faultPoint));
      store.close();
      expect(progressTableSnapshot(fixture.databasePath)).toBe(before);

      store = await newProgressStore(runtime, fixture, { amendmentAuthority: authority });
      service = serviceFor(runtime, fixture, store, authority);
      expect(service.acceptAmendment(amendmentRequest(amd), capability)).toMatchObject({ replayed: false });
      store.close();
      expect(progressRows(fixture.databasePath).events).toHaveLength(6);
      expect(progressRows(fixture.databasePath).outbox).toHaveLength(6);
    },
  );
});

async function acceptedProgressService(
  runtime: ProgressRuntime,
  amendmentRuntime: AmendmentRuntime,
  fixture: ProgressFixture,
): Promise<{
  store: ProgressStore;
  service: ProgressService;
  amd: AmendmentFixture;
  authority: AmendmentAcceptanceAuthority;
  capability: AmendmentAcceptanceCapability;
}> {
  const amd = amendmentFixture(fixture);
  const { authority, capability } = issuedAmendmentAuthority(amendmentRuntime, fixture, amd);
  const ready = await readyProgressService(runtime, fixture, authority);
  expect(ready.service.acceptAmendment(amendmentRequest(amd), capability)).toMatchObject({
    effectivePlanSha256: AMD_EFFECTIVE_PLAN_SHA256,
    replayed: false,
  });
  return { ...ready, amd, authority, capability };
}

const POST_AMENDMENT_STAGES = [
  "STG-04", "STG-05", "STG-06", "STG-07", "STG-08",
  "STG-09", "STG-10", "STG-11", "STG-12",
] as const;

type OptionalHarness = "grok" | "claude";
type ReviewRole = "auditor" | "critic";
type OptionalLaneStatus = "PASS" | "optional_unavailable";

interface PostAmendmentStagePacketInput {
  readonly fixture: ProgressFixture;
  readonly stageId: typeof POST_AMENDMENT_STAGES[number];
  readonly gateId?: string;
  readonly sequence: number;
  readonly previousEventSha256: string;
  readonly effectivePlanSha256: string;
  readonly recordedAt: number;
  readonly newLaunchesForStage?: number;
  readonly knownCostUsd?: number | null;
  readonly postStartLaunchesConsumed?: number;
  readonly postStartLaunchCap?: number;
  readonly postStartCostUsdConsumed?: number;
  readonly postStartCostUsdCap?: number;
  readonly statuses?: Partial<Record<`${OptionalHarness}:${ReviewRole}`, OptionalLaneStatus>>;
  readonly receiptLanes?: readonly `${OptionalHarness}:${ReviewRole}`[];
  readonly mutateOptional?: (optional: JsonObject) => void;
  readonly mutateBarrier?: (barrier: JsonObject) => void;
  readonly mutateReceipt?: (
    receipt: JsonObject,
    agent: "codex" | OptionalHarness,
    role: ReviewRole,
  ) => void;
  readonly hiddenReceiptOutput?: boolean;
}

function postAmendmentStagePacket(input: PostAmendmentStagePacketInput): JsonObject {
  const eventId = `${input.stageId.toLowerCase()}-pass-${input.sequence}`;
  const gateId = input.gateId ?? input.stageId;
  const base = `docs/hybrid-flow-v1-r2/test-progress/${eventId}`;
  const recordedAt = new Date(input.recordedAt).toISOString();
  const path = (name: string): string => `${base}/${name}`;
  const store = (name: string, bytes: Buffer): { path: string; sha256: string } => {
    const artifactPath = path(name);
    writeArtifact(input.fixture.repositoryRoot, artifactPath, bytes);
    return { path: artifactPath, sha256: sha256(bytes) };
  };
  const json = (value: JsonObject): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

  const source = store("source-manifest.json", json({
    schemaVersion: "source-manifest/v1",
    stageId: input.stageId,
    marker: eventId,
  }));
  const audit = store("audit-packet.md", Buffer.from(`# ${input.stageId} audit\n\nImmutable test packet.\n`, "utf8"));
  const testEvidence = store("test-evidence.json", json({
    schemaVersion: "test-evidence/v1",
    stageId: input.stageId,
    sourceFingerprint: source.sha256,
    result: "PASS",
  }));

  const laneKeys = (["grok", "claude"] as const).flatMap((agent) =>
    (["auditor", "critic"] as const).map((role) => `${agent}:${role}` as const));
  const statusFor = (key: `${OptionalHarness}:${ReviewRole}`): OptionalLaneStatus =>
    input.statuses?.[key] ?? "optional_unavailable";
  const provider = (agent: OptionalHarness): JsonObject => ({
    auditor: statusFor(`${agent}:auditor`),
    critic: statusFor(`${agent}:critic`),
    reason: "bounded optional lane disposition",
  });
  const launches = input.newLaunchesForStage ?? 0;
  const stageCost = input.knownCostUsd ?? null;
  const optional: JsonObject = {
    schemaVersion: "optional-review-status/v1",
    stageId: input.stageId,
    providers: { grok: provider("grok"), claude: provider("claude") },
    requiredTopology: {
      codex: ["auditor", "critic"],
      grok: ["auditor", "critic"],
      claude: ["auditor", "critic"],
    },
    blockingPolicy: "codex_pair_required_optional_pairs_non_blocking_when_unavailable",
    automaticRejoin: "enabled_by_runtime_health_admission_when_capacity_and_provider_health_return",
    ambiguousLaunchedAttempts: 0,
    completedChangesRequested: 0,
    certificationLaunchesConsumed: 40,
    certificationLaunchCap: 40,
    newLaunchesForStage: launches,
    knownCostUsd: stageCost,
    costStatus: stageCost === null ? "not_applicable_no_launch" : "known_final",
    postStartLaunchesConsumed: input.postStartLaunchesConsumed ?? launches,
    postStartLaunchCap: input.postStartLaunchCap ?? 24,
    postStartCostUsdConsumed: input.postStartCostUsdConsumed ?? (stageCost ?? 0),
    postStartCostUsdCap: input.postStartCostUsdCap ?? 10,
    recordedAt,
  };
  input.mutateOptional?.(optional);
  const optionalArtifact = store("optional-providers.json", json(optional));

  const receiptReferences: JsonObject[] = [];
  const attemptIds: string[] = [];
  const addReceipt = (agent: "codex" | OptionalHarness, role: ReviewRole): void => {
    const attemptId = `${eventId}-${agent}-${role}`;
    const receiptPath = path(`${agent}-${role}-receipt.json`);
    const receipt: JsonObject = {
      schemaVersion: "review-receipt/v1",
      agent,
      role,
      attemptId,
      reviewerTask: `/test/${agent}/${role}`,
      sourceFingerprint: source.sha256,
      reviewVerdict: {
        schemaVersion: "review-verdict/v1",
        verdict: "PASS",
        findings: [{ risk_level: "info", message: "bounded PASS fixture" }],
      },
    };
    input.mutateReceipt?.(receipt, agent, role);
    const receiptBytes = json(receipt);
    writeArtifact(input.fixture.repositoryRoot, receiptPath, receiptBytes);
    receiptReferences.push({
      agent,
      role,
      attemptId,
      artifactPath: receiptPath,
      sha256: sha256(receiptBytes),
    });
    attemptIds.push(attemptId);
  };
  addReceipt("codex", "auditor");
  addReceipt("codex", "critic");
  for (const key of input.receiptLanes ?? laneKeys.filter((key) => statusFor(key) === "PASS")) {
    const [agent, role] = key.split(":") as [OptionalHarness, ReviewRole];
    addReceipt(agent, role);
  }

  const requiredReceipts = receiptReferences.filter(({ agent }) => agent === "codex").map((reference) => ({
    agent: reference.agent,
    role: reference.role,
    attemptId: reference.attemptId,
    receiptSha256: reference.sha256,
  }));
  const optionalLanes = laneKeys.map((key) => {
    const [agent, role] = key.split(":") as [OptionalHarness, ReviewRole];
    return { agent, role, status: statusFor(key) };
  });
  const barrier: JsonObject = {
    schemaVersion: "review-barrier-evidence/v1",
    stageId: input.stageId,
    gateId,
    sourceFingerprint: source.sha256,
    satisfied: true,
    requiredCount: 2,
    terminalCount: 2,
    requiredReceipts,
    optionalLanes,
    optionalStatusSha256: optionalArtifact.sha256,
    ambiguousLaunchedAttempts: 0,
  };
  input.mutateBarrier?.(barrier);
  const barrierArtifact = store("barrier.json", json(barrier));

  const checks: JsonObject = { codexAuditor: "PASS", codexCritic: "PASS", ambiguousAttempts: 0 };
  for (const lane of optionalLanes) {
    const agent = String(lane.agent);
    const role = String(lane.role);
    checks[`${agent}${role[0]!.toUpperCase()}${role.slice(1)}`] = lane.status;
  }
  const oracleArtifact = store("terminal-oracle.json", json({
    schemaVersion: "terminal-oracle/v1",
    stageId: input.stageId,
    gateId,
    sourceFingerprint: source.sha256,
    terminalResult: "PASS",
    checks,
    recordedAt,
  }));

  const inputHashes = [source, audit];
  const hiddenReceipt = input.hiddenReceiptOutput ? store("hidden-grok-auditor-receipt.json", json({
    schemaVersion: "review-receipt/v1",
    agent: "grok",
    role: "auditor",
    attemptId: `${eventId}-hidden-grok-auditor`,
    reviewerTask: "/test/hidden/grok/auditor",
    sourceFingerprint: source.sha256,
    reviewVerdict: {
      schemaVersion: "review-verdict/v1",
      verdict: "PASS",
      findings: [{ risk_level: "info", message: "undeclared synthetic receipt" }],
    },
  })) : null;
  const outputHashes = [
    testEvidence,
    optionalArtifact,
    barrierArtifact,
    oracleArtifact,
    ...(hiddenReceipt ? [hiddenReceipt] : []),
  ];
  const artifactPaths = [
    ...inputHashes.map(({ path: artifactPath }) => artifactPath),
    ...outputHashes.map(({ path: artifactPath }) => artifactPath),
    ...receiptReferences.map(({ artifactPath }) => String(artifactPath)),
  ];
  return withCanonicalHash({
    schemaVersion: "PlanProgressEvent/v1",
    eventId,
    sequence: input.sequence,
    previousEventSha256: input.previousEventSha256,
    startSha256: R2_START_SHA256,
    eventType: "step_completed",
    planId: R2_PLAN_ID,
    effectivePlanSha256: input.effectivePlanSha256,
    stageId: input.stageId,
    gateId,
    sourceFingerprint: source.sha256,
    actor: "codex:/root",
    commandOrOracle: { kind: "oracle", artifactPath: oracleArtifact.path, sha256: oracleArtifact.sha256 },
    inputHashes,
    outputHashes,
    attemptIds,
    reviewReceiptHashes: receiptReferences,
    artifactPaths,
    terminalResult: "PASS",
    recordedAt,
  }, "eventSha256");
}

describe("post-amendment progress authority and stage automaton", () => {
  it("atomically appends completion plus the next eligibility, derives count and USD cost, and replays zero-write", async () => {
    const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
    const fixture = newFixture();
    const accepted = await acceptedProgressService(runtime, amendmentRuntime, fixture);
    const snapshot = accepted.store.snapshotProjection();
    const completion = postAmendmentStagePacket({
      fixture,
      stageId: "STG-04",
      sequence: 7,
      previousEventSha256: snapshot.watermarkEventSha256,
      effectivePlanSha256: AMD_EFFECTIVE_PLAN_SHA256,
      recordedAt: AMD_ACCEPTED_AT + 2,
      newLaunchesForStage: 2,
      knownCostUsd: 1.25,
      postStartLaunchesConsumed: 2,
      postStartCostUsdConsumed: 1.25,
    });
    expect(accepted.service.appendEvent({ event: completion, eventJson: canonicalJson(completion) })).toEqual({
      eventId: completion.eventId,
      sequence: 7,
      replayed: false,
    });
    const committed = progressRows(fixture.databasePath);
    expect(committed.events).toHaveLength(8);
    expect(committed.events.slice(6).map(({ event_json }) => {
      const event = JSON.parse(String(event_json)) as JsonObject;
      return `${String(event.eventType)}:${String(event.stageId)}`;
    })).toEqual(["step_completed:STG-04", "step_eligible:STG-05"]);
    expect(accepted.service.verify().launchAccounting.postStart).toEqual({
      cap: 24,
      consumed: 2,
      remaining: 22,
      costCapUsd: 10,
      costConsumedUsd: 1.25,
      costRemainingUsd: 8.75,
    });
    const beforeReplay = progressTableSnapshot(fixture.databasePath);
    expect(accepted.service.appendEvent({ event: completion, eventJson: canonicalJson(completion) }))
      .toMatchObject({ replayed: true, sequence: 7 });
    expect(progressTableSnapshot(fixture.databasePath)).toBe(beforeReplay);
    accepted.store.close();
  });

  it("rolls back completion and derived eligibility together and replays the whole transition", async () => {
    const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
    const fixture = newFixture();
    const accepted = await acceptedProgressService(runtime, amendmentRuntime, fixture);
    accepted.store.close();
    const before = progressTableSnapshot(fixture.databasePath);
    const completion = postAmendmentStagePacket({
      fixture,
      stageId: "STG-04",
      sequence: 7,
      previousEventSha256: String(progressRows(fixture.databasePath).events[5]!.event_sha256),
      effectivePlanSha256: AMD_EFFECTIVE_PLAN_SHA256,
      recordedAt: AMD_ACCEPTED_AT + 2,
    });
    const injected = await newProgressStore(runtime, fixture, {
      faultInjector: (point) => {
        if (point === "after_progress_outbox_insert") throw new Error("injected stage transition crash");
      },
    });
    const injectedService = serviceFor(runtime, fixture, injected, accepted.authority);
    expect(() => injectedService.appendEvent({ event: completion, eventJson: canonicalJson(completion) }))
      .toThrow(/injected stage transition crash/i);
    injected.close();
    expect(progressTableSnapshot(fixture.databasePath)).toBe(before);

    const recovery = await newProgressStore(runtime, fixture);
    const recoveryService = serviceFor(runtime, fixture, recovery, accepted.authority);
    expect(recoveryService.appendEvent({ event: completion, eventJson: canonicalJson(completion) }))
      .toMatchObject({ sequence: 7, replayed: false });
    expect(progressRows(fixture.databasePath).events).toHaveLength(8);
    recovery.close();
  });

  it("fully verifies the existing semantic ledger before considering another append", async () => {
    const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
    const fixture = newFixture();
    const accepted = await acceptedProgressService(runtime, amendmentRuntime, fixture);
    const snapshot = accepted.store.snapshotProjection();
    const poisoned = withCanonicalHash({
      schemaVersion: "PlanProgressEvent/v1",
      eventId: "lower-layer-forged-stg-08-eligible",
      sequence: 7,
      previousEventSha256: snapshot.watermarkEventSha256,
      startSha256: R2_START_SHA256,
      eventType: "step_eligible",
      planId: R2_PLAN_ID,
      effectivePlanSha256: AMD_EFFECTIVE_PLAN_SHA256,
      stageId: "STG-08",
      recordedAt: new Date(AMD_ACCEPTED_AT + 2).toISOString(),
    }, "eventSha256");
    injectProgressEvent(fixture.databasePath, poisoned);
    const candidate = postAmendmentStagePacket({
      fixture,
      stageId: "STG-04",
      sequence: 8,
      previousEventSha256: String(poisoned.eventSha256),
      effectivePlanSha256: AMD_EFFECTIVE_PLAN_SHA256,
      recordedAt: AMD_ACCEPTED_AT + 3,
    });
    const before = progressTableSnapshot(fixture.databasePath);
    expect(() => accepted.service.appendEvent({ event: candidate, eventJson: canonicalJson(candidate) }))
      .toThrow(/STG-08|eligibility|order|semantic/i);
    expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
    accepted.store.close();
  });

  it.each(["amendment_accepted", "step_eligible"] as const)(
    "rejects public %s events with zero writes",
    async (eventType) => {
      const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
      const fixture = newFixture();
      const accepted = await acceptedProgressService(runtime, amendmentRuntime, fixture);
      const snapshot = accepted.store.snapshotProjection();
      const base = eventType === "step_eligible"
        ? {
          schemaVersion: "PlanProgressEvent/v1", eventId: "forged-stg-08-eligible", sequence: 7,
          previousEventSha256: snapshot.watermarkEventSha256, startSha256: R2_START_SHA256,
          eventType, planId: R2_PLAN_ID, effectivePlanSha256: AMD_EFFECTIVE_PLAN_SHA256,
          stageId: "STG-08", recordedAt: new Date(AMD_ACCEPTED_AT + 2).toISOString(),
        }
        : {
          schemaVersion: "PlanProgressEvent/v1", eventId: "forged-amendment", sequence: 7,
          previousEventSha256: snapshot.watermarkEventSha256, startSha256: R2_START_SHA256,
          eventType, planId: R2_PLAN_ID, effectivePlanSha256: "7".repeat(64),
          previousEffectivePlanSha256: AMD_EFFECTIVE_PLAN_SHA256, amendmentSha256: "8".repeat(64),
          authorityReceiptSha256: "9".repeat(64), invalidatedEventIds: [],
          recordedAt: new Date(AMD_ACCEPTED_AT + 2).toISOString(),
        };
      const event = withCanonicalHash(base, "eventSha256");
      const before = progressTableSnapshot(fixture.databasePath);
      expect(() => accepted.service.appendEvent({ event, eventJson: canonicalJson(event) }))
        .toThrow(/public|authority|eligible|amendment|transition/i);
      expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
      accepted.store.close();
    },
  );

  it.each(["step_eligible", "step_completed"] as const)(
    "rejects an already-poisoned pre-AMD %s after the four baseline completions",
    async (eventType) => {
      const runtime = await loadProgressRuntime();
      const fixture = newFixture();
      const ready = await readyProgressService(runtime, fixture);
      const snapshot = ready.store.snapshotProjection();
      const base = eventType === "step_eligible"
        ? {
          schemaVersion: "PlanProgressEvent/v1", eventId: "pre-amd-stg-04-eligible", sequence: 5,
          previousEventSha256: snapshot.watermarkEventSha256, startSha256: R2_START_SHA256,
          eventType, planId: R2_PLAN_ID, effectivePlanSha256: R2_PLAN_SHA256,
          stageId: "STG-04", recordedAt: new Date(AMD_ACCEPTED_AT).toISOString(),
        }
        : {
          ...structuredClone(readR2ProgressEvent(4)),
          eventId: "pre-amd-stg-04-pass",
          sequence: 5,
          previousEventSha256: snapshot.watermarkEventSha256,
          stageId: "STG-04",
          gateId: "STG-04",
          recordedAt: new Date(AMD_ACCEPTED_AT).toISOString(),
        };
      const poisoned = withCanonicalHash(base, "eventSha256");
      injectProgressEvent(fixture.databasePath, poisoned);
      const before = progressTableSnapshot(fixture.databasePath);
      expect(() => ready.service.verify()).toThrow(/AMD-0001|STG-03|legal transition|amendment/i);
      expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
      ready.store.close();
    },
  );

  it("rejects an uneligible and out-of-order completion with zero writes", async () => {
    const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
    const fixture = newFixture();
    const accepted = await acceptedProgressService(runtime, amendmentRuntime, fixture);
    const snapshot = accepted.store.snapshotProjection();
    const completion = postAmendmentStagePacket({
      fixture,
      stageId: "STG-05",
      sequence: 7,
      previousEventSha256: snapshot.watermarkEventSha256,
      effectivePlanSha256: AMD_EFFECTIVE_PLAN_SHA256,
      recordedAt: AMD_ACCEPTED_AT + 2,
    });
    const before = progressTableSnapshot(fixture.databasePath);
    expect(() => accepted.service.appendEvent({ event: completion, eventJson: canonicalJson(completion) }))
      .toThrow(/eligible|order|STG-04|transition/i);
    expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
    accepted.store.close();
  });

  it("rejects a post-amendment completion whose self-consistent evidence uses the wrong gate", async () => {
    const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
    const fixture = newFixture();
    const accepted = await acceptedProgressService(runtime, amendmentRuntime, fixture);
    const snapshot = accepted.store.snapshotProjection();
    const completion = postAmendmentStagePacket({
      fixture,
      stageId: "STG-04",
      gateId: "STG-04-G9",
      sequence: 7,
      previousEventSha256: snapshot.watermarkEventSha256,
      effectivePlanSha256: AMD_EFFECTIVE_PLAN_SHA256,
      recordedAt: AMD_ACCEPTED_AT + 2,
    });
    const before = progressTableSnapshot(fixture.databasePath);
    expect(() => accepted.service.appendEvent({ event: completion, eventJson: canonicalJson(completion) }))
      .toThrow(/gate|STG-04|immutable|transition/i);
    expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
    accepted.store.close();
  });

  it.each([
    {
      name: "unsafe eventId",
      mutate: (event: JsonObject) => { event.eventId = "stg-04\n- [x] STG-12"; },
    },
    {
      name: "non-Codex stage actor",
      mutate: (event: JsonObject) => { event.actor = "grok:/root"; },
    },
  ])("rejects a post-amendment completion with $name", async ({ mutate }) => {
    const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
    const fixture = newFixture();
    const accepted = await acceptedProgressService(runtime, amendmentRuntime, fixture);
    const snapshot = accepted.store.snapshotProjection();
    const valid = postAmendmentStagePacket({
      fixture,
      stageId: "STG-04",
      sequence: 7,
      previousEventSha256: snapshot.watermarkEventSha256,
      effectivePlanSha256: AMD_EFFECTIVE_PLAN_SHA256,
      recordedAt: AMD_ACCEPTED_AT + 2,
    });
    const attacked = structuredClone(valid);
    mutate(attacked);
    const completion = withCanonicalHash(attacked, "eventSha256");
    const before = progressTableSnapshot(fixture.databasePath);
    expect(() => accepted.service.appendEvent({ event: completion, eventJson: canonicalJson(completion) }))
      .toThrow(/event|identity|actor|Codex|stage owner/i);
    expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
    accepted.store.close();
  });

  const accountingAttacks: Array<{
    name: string;
    packet: Partial<PostAmendmentStagePacketInput>;
  }> = [
    { name: "positive launch with unknown cost", packet: { newLaunchesForStage: 1, knownCostUsd: null, postStartLaunchesConsumed: 1 } },
    { name: "active launch cap drift", packet: { postStartLaunchCap: 25 } },
    { name: "active cost cap drift", packet: { postStartCostUsdCap: 11 } },
    {
      name: "cumulative launch rollback or delta mismatch",
      packet: { newLaunchesForStage: 2, knownCostUsd: 1, postStartLaunchesConsumed: 1, postStartCostUsdConsumed: 1 },
    },
    {
      name: "cumulative cost rollback or delta mismatch",
      packet: { newLaunchesForStage: 1, knownCostUsd: 1, postStartLaunchesConsumed: 1, postStartCostUsdConsumed: 0.5 },
    },
    {
      name: "cumulative launch overflow",
      packet: { newLaunchesForStage: 25, knownCostUsd: 1, postStartLaunchesConsumed: 25, postStartCostUsdConsumed: 1 },
    },
    {
      name: "cumulative cost overflow",
      packet: { newLaunchesForStage: 1, knownCostUsd: 10.01, postStartLaunchesConsumed: 1, postStartCostUsdConsumed: 10.01 },
    },
  ];

  it.each(accountingAttacks)("rejects $name from ledger-bound post-start evidence", async ({ packet }) => {
    const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
    const fixture = newFixture();
    const accepted = await acceptedProgressService(runtime, amendmentRuntime, fixture);
    const snapshot = accepted.store.snapshotProjection();
    const completion = postAmendmentStagePacket({
      fixture,
      stageId: "STG-04",
      sequence: 7,
      previousEventSha256: snapshot.watermarkEventSha256,
      effectivePlanSha256: AMD_EFFECTIVE_PLAN_SHA256,
      recordedAt: AMD_ACCEPTED_AT + 2,
      ...packet,
    });
    const before = progressTableSnapshot(fixture.databasePath);
    expect(() => accepted.service.appendEvent({ event: completion, eventJson: canonicalJson(completion) }))
      .toThrow(/post.start|launch|cost|24|10|delta|rollback|cap|authority/i);
    expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
    accepted.store.close();
  });

  const optionalSchemaAttacks: Array<{
    name: string;
    statuses?: PostAmendmentStagePacketInput["statuses"];
    receiptLanes?: PostAmendmentStagePacketInput["receiptLanes"];
    mutateOptional?: (optional: JsonObject) => void;
    mutateBarrier?: (barrier: JsonObject) => void;
    mutateReceipt?: PostAmendmentStagePacketInput["mutateReceipt"];
    hiddenReceiptOutput?: boolean;
  }> = [
    {
      name: "unknown provider",
      mutateOptional: (optional) => { (optional.providers as JsonObject).gemini = { auditor: "optional_unavailable" }; },
    },
    {
      name: "unknown provider role field",
      mutateOptional: (optional) => { ((optional.providers as JsonObject).grok as JsonObject).observer = "optional_unavailable"; },
    },
    {
      name: "duplicate barrier lane hiding a required lane",
      mutateBarrier: (barrier) => {
        const lanes = barrier.optionalLanes as JsonObject[];
        lanes[3] = structuredClone(lanes[0]!);
      },
    },
    {
      name: "synthetic receipt field on unavailable lane",
      mutateOptional: (optional) => { ((optional.providers as JsonObject).grok as JsonObject).auditorReceiptSha256 = "a".repeat(64); },
    },
    {
      name: "PASS without its exact receipt",
      statuses: { "grok:auditor": "PASS" },
      receiptLanes: [],
    },
    {
      name: "receipt attached to unavailable lane",
      receiptLanes: ["grok:auditor"],
    },
    {
      name: "optional PASS receipt rebound to another source",
      statuses: { "grok:auditor": "PASS" },
      mutateReceipt: (receipt, agent, role) => {
        if (agent === "grok" && role === "auditor") receipt.sourceFingerprint = "f".repeat(64);
      },
    },
    {
      name: "hidden synthetic receipt artifact on unavailable lane",
      hiddenReceiptOutput: true,
    },
  ];

  it.each(optionalSchemaAttacks)("rejects optional review ambiguity: $name", async (attack) => {
    const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
    const fixture = newFixture();
    const accepted = await acceptedProgressService(runtime, amendmentRuntime, fixture);
    const snapshot = accepted.store.snapshotProjection();
    const completion = postAmendmentStagePacket({
      fixture,
      stageId: "STG-04",
      sequence: 7,
      previousEventSha256: snapshot.watermarkEventSha256,
      effectivePlanSha256: AMD_EFFECTIVE_PLAN_SHA256,
      recordedAt: AMD_ACCEPTED_AT + 2,
      ...(attack.statuses ? { statuses: attack.statuses } : {}),
      ...(attack.receiptLanes ? { receiptLanes: attack.receiptLanes } : {}),
      ...(attack.mutateOptional ? { mutateOptional: attack.mutateOptional } : {}),
      ...(attack.mutateBarrier ? { mutateBarrier: attack.mutateBarrier } : {}),
      ...(attack.mutateReceipt ? { mutateReceipt: attack.mutateReceipt } : {}),
      ...(attack.hiddenReceiptOutput ? { hiddenReceiptOutput: true } : {}),
    });
    const before = progressTableSnapshot(fixture.databasePath);
    expect(() => accepted.service.appendEvent({ event: completion, eventJson: canonicalJson(completion) }))
      .toThrow(/optional|provider|lane|receipt|role|unique|exhaustive|field/i);
    expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
    accepted.store.close();
  });

  it("accepts exact source-bound optional PASS receipts and enforces the full STG-04..12 order", async () => {
    const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
    const fixture = newFixture();
    const accepted = await acceptedProgressService(runtime, amendmentRuntime, fixture);
    let launches = 0;
    let cost = 0;
    for (const [index, stageId] of POST_AMENDMENT_STAGES.entries()) {
      const snapshot = accepted.store.snapshotProjection();
      const launched = index === 0 ? 1 : 0;
      const stageCost = index === 0 ? 0.5 : null;
      launches += launched;
      cost += stageCost ?? 0;
      const completion = postAmendmentStagePacket({
        fixture,
        stageId,
        sequence: snapshot.watermarkSequence + 1,
        previousEventSha256: snapshot.watermarkEventSha256,
        effectivePlanSha256: AMD_EFFECTIVE_PLAN_SHA256,
        recordedAt: AMD_ACCEPTED_AT + 2 + index * 2,
        newLaunchesForStage: launched,
        knownCostUsd: stageCost,
        postStartLaunchesConsumed: launches,
        postStartCostUsdConsumed: cost,
        ...(index === 0 ? { statuses: { "grok:auditor": "PASS" as const } } : {}),
      });
      expect(accepted.service.appendEvent({ event: completion, eventJson: canonicalJson(completion) }))
        .toMatchObject({ replayed: false, eventId: completion.eventId });
      const after = accepted.store.snapshotProjection();
      const last = after.events.at(-1)!;
      if (stageId === "STG-12") expect(last).toMatchObject({ eventType: "step_completed", stageId: "STG-12" });
      else expect(last).toMatchObject({ eventType: "step_eligible", stageId: POST_AMENDMENT_STAGES[index + 1] });
    }
    expect(accepted.service.verify().launchAccounting.postStart).toMatchObject({
      consumed: 1,
      remaining: 23,
      costConsumedUsd: 0.5,
      costRemainingUsd: 9.5,
    });
    accepted.store.close();
  });
});

describe("SQLite-authoritative verification and R2 evidence parity", () => {
  const ledgerAttacks: Array<{ name: string; sql: string; args?: readonly unknown[] }> = [
    { name: "canonical event JSON tamper", sql: "UPDATE plan_progress_events SET event_json='{}' WHERE sequence_no=3" },
    { name: "event hash tamper", sql: "UPDATE plan_progress_events SET event_sha256=? WHERE sequence_no=3", args: ["0".repeat(64)] },
    { name: "chain root tamper", sql: "UPDATE plan_progress_events SET previous_event_sha256=? WHERE sequence_no=3", args: ["0".repeat(64)] },
    { name: "sequence gap", sql: "UPDATE plan_progress_events SET sequence_no=9 WHERE sequence_no=3" },
    { name: "outbox projection tamper", sql: "UPDATE plan_progress_outbox SET projection_payload_json='{}' WHERE event_id='stg-03-pass'" },
    { name: "missing ledger row", sql: "DELETE FROM plan_progress_events WHERE sequence_no=2" },
  ];

  it.each(ledgerAttacks)("fails closed on $name without repairing or mutating the ledger", async ({ sql, args = [] }) => {
    const runtime = await loadProgressRuntime();
    const fixture = newFixture();
    const ready = await readyProgressService(runtime, fixture);
    ready.store.close();
    const db = new Database(fixture.databasePath);
    try {
      db.pragma("foreign_keys = OFF");
      db.prepare(sql).run(...args);
    } finally {
      db.close();
    }
    const before = progressTableSnapshot(fixture.databasePath);
    const store = await newProgressStore(runtime, fixture);
    expect(() => {
      serviceFor(runtime, fixture, store).verify();
    }).toThrow(/ledger|chain|canonical|hash|gap|outbox|projection|integrity/i);
    store?.close();
    expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
  });

  const acceptedLedgerAttacks: Array<{
    name: string;
    sql: string;
    args?: readonly unknown[];
  }> = ([5, 6] as const).flatMap((sequence) => [
    { name: `event ${sequence} canonical JSON`, sql: `UPDATE plan_progress_events SET event_json='{}' WHERE sequence_no=${sequence}` },
    { name: `event ${sequence} plan projection`, sql: `UPDATE plan_progress_events SET plan_id='wrong-plan' WHERE sequence_no=${sequence}` },
    { name: `event ${sequence} start projection`, sql: `UPDATE plan_progress_events SET start_sha256=? WHERE sequence_no=${sequence}`, args: ["0".repeat(64)] },
    { name: `event ${sequence} predecessor projection`, sql: `UPDATE plan_progress_events SET previous_event_sha256=? WHERE sequence_no=${sequence}`, args: ["0".repeat(64)] },
    { name: `event ${sequence} effective epoch projection`, sql: `UPDATE plan_progress_events SET effective_plan_sha256=? WHERE sequence_no=${sequence}`, args: ["0".repeat(64)] },
    { name: `event ${sequence} digest projection`, sql: `UPDATE plan_progress_events SET event_sha256=? WHERE sequence_no=${sequence}`, args: ["0".repeat(64)] },
    { name: `event ${sequence} time projection`, sql: `UPDATE plan_progress_events SET created_at=created_at+1 WHERE sequence_no=${sequence}` },
    { name: `event ${sequence} identity projection`, sql: `UPDATE plan_progress_events SET event_id='tampered-${sequence}' WHERE sequence_no=${sequence}` },
    { name: `event ${sequence} sequence projection`, sql: `UPDATE plan_progress_events SET sequence_no=${sequence + 40} WHERE sequence_no=${sequence}` },
    {
      name: `event ${sequence} outbox payload projection`,
      sql: `UPDATE plan_progress_outbox SET projection_payload_json='{}'
        WHERE rowid=(SELECT rowid FROM plan_progress_outbox ORDER BY rowid LIMIT 1 OFFSET ${sequence - 1})`,
    },
    {
      name: `event ${sequence} missing outbox projection`,
      sql: `DELETE FROM plan_progress_outbox
        WHERE rowid=(SELECT rowid FROM plan_progress_outbox ORDER BY rowid LIMIT 1 OFFSET ${sequence - 1})`,
    },
    {
      name: `event ${sequence} outbox identity projection`,
      sql: `UPDATE plan_progress_outbox SET event_id='tampered-outbox-${sequence}'
        WHERE rowid=(SELECT rowid FROM plan_progress_outbox ORDER BY rowid LIMIT 1 OFFSET ${sequence - 1})`,
    },
    { name: `event ${sequence} missing ledger row`, sql: `DELETE FROM plan_progress_events WHERE sequence_no=${sequence}` },
  ]);

  it.each(acceptedLedgerAttacks)(
    "fails closed on accepted amendment $name without repair",
    async ({ sql, args = [] }) => {
      const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
      const fixture = newFixture();
      const accepted = await acceptedProgressService(runtime, amendmentRuntime, fixture);
      accepted.store.close();
      const db = new Database(fixture.databasePath);
      try {
        db.pragma("foreign_keys = OFF");
        db.prepare(sql).run(...args);
      } finally {
        db.close();
      }
      const before = progressTableSnapshot(fixture.databasePath);
      const store = await newProgressStore(runtime, fixture);
      expect(() => {
        serviceFor(runtime, fixture, store, accepted.authority).verify();
      }).toThrow(/ledger|chain|canonical|hash|digest|identity|time|outbox|projection|integrity|epoch|amendment/i);
      store?.close();
      expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
    },
  );

  const acceptedSemanticAttacks: Array<{
    name: string;
    sequence: 5 | 6;
    mutate: (event: JsonObject) => void;
  }> = [
    { name: "amendment digest", sequence: 5, mutate: (event) => { event.amendmentSha256 = "0".repeat(64); } },
    { name: "authority receipt digest", sequence: 5, mutate: (event) => { event.authorityReceiptSha256 = "0".repeat(64); } },
    { name: "previous effective epoch", sequence: 5, mutate: (event) => { event.previousEffectivePlanSha256 = "0".repeat(64); } },
    { name: "nonempty invalidation", sequence: 5, mutate: (event) => { event.invalidatedEventIds = ["stg-02-pass"]; } },
    {
      name: "embedded authority consumer",
      sequence: 5,
      mutate: (event) => { (event.authorityReceipt as JsonObject).consumer = "attacker"; },
    },
    { name: "acceptance event type", sequence: 5, mutate: (event) => { event.eventType = "step_eligible"; } },
    { name: "STG-08 early eligibility", sequence: 6, mutate: (event) => { event.stageId = "STG-08"; } },
    { name: "wrong eligibility event type", sequence: 6, mutate: (event) => { event.eventType = "step_completed"; } },
    { name: "old effective epoch", sequence: 6, mutate: (event) => { event.effectivePlanSha256 = R2_PLAN_SHA256; } },
    { name: "eligibility before acceptance", sequence: 6, mutate: (event) => { event.recordedAt = AMD_RECORDED_AT; } },
    { name: "unexpected eligibility invalidation", sequence: 6, mutate: (event) => { event.invalidatedEventIds = []; } },
  ];

  it.each(acceptedSemanticAttacks)(
    "rejects self-consistent accepted-amendment semantic tamper: $name",
    async ({ sequence, mutate }) => {
      const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
      const fixture = newFixture();
      const accepted = await acceptedProgressService(runtime, amendmentRuntime, fixture);
      accepted.store.close();
      rewriteEventChain(fixture, sequence, mutate);
      const before = progressTableSnapshot(fixture.databasePath);
      const store = await newProgressStore(runtime, fixture);
      expect(() => serviceFor(runtime, fixture, store, accepted.authority).verify())
        .toThrow(/AMD|amendment|authority|receipt|epoch|invalidation|eligible|STG-04|event|chronology|semantic/i);
      store.close();
      expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
    },
  );

  const acceptedAmendmentArtifactAttacks: Array<{
    name: string;
    mutate: (fixture: ProgressFixture, amd: AmendmentFixture) => void;
  }> = [
    {
      name: "missing canonical AMD file",
      mutate: (fixture, amd) => { rmSync(join(fixture.repositoryRoot, amd.amendmentPath)); },
    },
    {
      name: "tampered canonical AMD file bytes",
      mutate: (fixture, amd) => {
        writeArtifact(fixture.repositoryRoot, amd.amendmentPath, Buffer.concat([amd.amendmentBytes, Buffer.from(" ")]));
      },
    },
    {
      name: "missing canonical authority file",
      mutate: (fixture, amd) => { rmSync(join(fixture.repositoryRoot, amd.authorityReceiptPath)); },
    },
    {
      name: "tampered canonical authority file bytes",
      mutate: (fixture, amd) => {
        writeArtifact(
          fixture.repositoryRoot,
          amd.authorityReceiptPath,
          Buffer.concat([amd.authorityReceiptBytes, Buffer.from(" ")]),
        );
      },
    },
  ];

  it.each(acceptedAmendmentArtifactAttacks)(
    "reopened verification rejects $name without rewriting SQLite",
    async ({ mutate }) => {
      const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
      const fixture = newFixture();
      const accepted = await acceptedProgressService(runtime, amendmentRuntime, fixture);
      accepted.store.close();
      mutate(fixture, accepted.amd);
      const before = progressTableSnapshot(fixture.databasePath);
      const store = await newProgressStore(runtime, fixture);
      expect(() => serviceFor(runtime, fixture, store, accepted.authority).verify())
        .toThrow(/AMD|amendment|authority|artifact|file|missing|canonical|digest|hash/i);
      store.close();
      expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
    },
  );

  const evidenceParityAttacks: Array<{
    name: string;
    mutate: (fixture: ProgressFixture) => void;
  }> = [
    {
      name: "wrong stage with a valid event hash chain",
      mutate: (fixture) => { rewriteEventChain(fixture, 4, (event) => { event.stageId = "STG-12"; }); },
    },
    {
      name: "wrong gate with a valid event hash chain",
      mutate: (fixture) => { rewriteEventChain(fixture, 4, (event) => { event.gateId = "STG-12-G1"; }); },
    },
    {
      name: "missing hashed artifact",
      mutate: (fixture) => {
        rmSync(join(fixture.repositoryRoot, "docs/hybrid-flow-v1-r2/stage-close/STG-03-test-evidence.json"));
      },
    },
    {
      name: "modified hashed artifact",
      mutate: (fixture) => {
        writeFileSync(join(fixture.repositoryRoot, "docs/hybrid-flow-v1-r2/stage-close/STG-03-test-evidence.json"), "{}\n");
      },
    },
    {
      name: "missing Codex auditor receipt",
      mutate: (fixture) => {
        rmSync(join(fixture.repositoryRoot, "docs/hybrid-flow-v1-r2/stage-close/STG-03-codex-auditor-receipt.json"));
      },
    },
    {
      name: "missing Codex critic receipt",
      mutate: (fixture) => {
        rmSync(join(fixture.repositoryRoot, "docs/hybrid-flow-v1-r2/stage-close/STG-03-codex-critic-receipt.json"));
      },
    },
    {
      name: "non-PASS Codex auditor receipt with rebound hashes",
      mutate: (fixture) => updateBoundArtifact(
        fixture,
        4,
        "docs/hybrid-flow-v1-r2/stage-close/STG-03-codex-auditor-receipt.json",
        (receipt) => { ((receipt.reviewVerdict as JsonObject).verdict) = "CHANGES_REQUESTED"; },
      ),
    },
    {
      name: "non-PASS Codex critic receipt with rebound hashes",
      mutate: (fixture) => updateBoundArtifact(
        fixture,
        4,
        "docs/hybrid-flow-v1-r2/stage-close/STG-03-codex-critic-receipt.json",
        (receipt) => { ((receipt.reviewVerdict as JsonObject).verdict) = "CHANGES_REQUESTED"; },
      ),
    },
    {
      name: "receipt/source mismatch with rebound hashes",
      mutate: (fixture) => updateBoundArtifact(
        fixture,
        4,
        "docs/hybrid-flow-v1-r2/stage-close/STG-03-codex-critic-receipt.json",
        (receipt) => { receipt.sourceFingerprint = "0".repeat(64); },
      ),
    },
    {
      name: "barrier mismatch with rebound hashes",
      mutate: (fixture) => updateBoundArtifact(
        fixture,
        4,
        "docs/hybrid-flow-v1-r2/stage-close/STG-03-barrier.json",
        (barrier) => { barrier.satisfied = false; },
      ),
    },
    {
      name: "terminal oracle mismatch with rebound hashes",
      mutate: (fixture) => updateBoundArtifact(
        fixture,
        4,
        "docs/hybrid-flow-v1-r2/stage-close/STG-03-terminal-oracle.json",
        (oracle) => { oracle.terminalResult = "FAIL"; },
      ),
    },
  ];

  it.each(evidenceParityAttacks)("rejects $name and leaves event/outbox tables byte-equivalent", async ({ mutate }) => {
    const runtime = await loadProgressRuntime();
    const fixture = newFixture();
    const ready = await readyProgressService(runtime, fixture);
    ready.store.close();
    mutate(fixture);
    const before = progressTableSnapshot(fixture.databasePath);
    const store = await newProgressStore(runtime, fixture);
    expect(() => serviceFor(runtime, fixture, store).verify())
      .toThrow(/stage|gate|artifact|digest|receipt|auditor|critic|source|barrier|oracle|PASS/i);
    store.close();
    expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
  });

  it("accepts exact optional_unavailable semantics with no synthetic receipts and the narrow legacy-null allowlist", async () => {
    const runtime = await loadProgressRuntime();
    const fixture = newFixture();
    const { store, service } = await readyProgressService(runtime, fixture);
    const result = service.verify();
    expect(result).toMatchObject({
      status: "verified",
      authority: "sqlite",
      progressEventCount: 4,
      lastEventSha256: STG03_EVENT_SHA256,
      effectivePlanSha256: R2_PLAN_SHA256,
      launchAccounting: {
        historical: {
          recordedCap: 40,
          consumed: 40,
          legacyNullDerivedZero: [
            "r2-stg-00-pass@ca0e9dbd810ab6ed41c8b25c760b71d5bee8c621b60d3895fc778634e63c0bd7",
            "stg-01-pass@98e901f40784a4b7d2bba23847b80e491f808eb710e14f9ce2fc59f070bb8b97",
          ],
        },
        postStart: { cap: 24, consumed: 0, remaining: 24 },
      },
    });
    for (const stage of ["R2-STG-00", "STG-01", "STG-02", "STG-03"]) {
      const optional = readFileSync(join(
        fixture.repositoryRoot,
        `docs/hybrid-flow-v1-r2/stage-close/${stage}-optional-providers.json`,
      ), "utf8");
      expect(optional).not.toMatch(/receiptPath|receiptSha256/);
    }
    store.close();
  });

  const optionalAndCapAttacks: Array<{
    name: string;
    sequence: 3 | 4;
    mutate: (optional: JsonObject) => void;
  }> = [
    {
      name: "completed optional changes_requested",
      sequence: 4,
      mutate: (optional) => {
        ((optional.providers as JsonObject).grok as JsonObject).auditor = "changes_requested";
        optional.completedChangesRequested = 1;
      },
    },
    {
      name: "ambiguous launched optional attempt",
      sequence: 4,
      mutate: (optional) => {
        ((optional.providers as JsonObject).grok as JsonObject).auditor = "ambiguous";
        optional.ambiguousLaunchedAttempts = 1;
      },
    },
    {
      name: "null stage delta after the legacy allowlist",
      sequence: 3,
      mutate: (optional) => { delete optional.newLaunchesForStage; },
    },
    {
      name: "positive stage delta with unknown cost",
      sequence: 4,
      mutate: (optional) => {
        optional.newLaunchesForStage = 1;
        optional.certificationLaunchesConsumed = 41;
        optional.knownCostUsd = null;
        optional.costStatus = "unknown";
      },
    },
    {
      name: "cumulative launch overflow",
      sequence: 4,
      mutate: (optional) => {
        optional.newLaunchesForStage = 1;
        optional.certificationLaunchesConsumed = 41;
      },
    },
    {
      name: "launch counter rollback",
      sequence: 4,
      mutate: (optional) => { optional.certificationLaunchesConsumed = 39; },
    },
    {
      name: "silent launch cap change",
      sequence: 4,
      mutate: (optional) => { optional.certificationLaunchCap = 41; },
    },
    {
      name: "known cost overflow",
      sequence: 4,
      mutate: (optional) => {
        optional.knownCostUsd = 10.01;
        optional.costStatus = "known_final";
      },
    },
  ];

  it.each(optionalAndCapAttacks)("blocks $name without a verifier write", async ({ sequence, mutate }) => {
    const runtime = await loadProgressRuntime();
    const fixture = newFixture();
    const ready = await readyProgressService(runtime, fixture);
    ready.store.close();
    coherentOptionalMutation(fixture, sequence, mutate);
    const before = progressTableSnapshot(fixture.databasePath);
    const store = await newProgressStore(runtime, fixture);
    expect(() => serviceFor(runtime, fixture, store).verify())
      .toThrow(/optional|changes_requested|ambiguous|launch|delta|cost|cap|counter|overflow|allowlist/i);
    store.close();
    expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
  });

  it("keeps SQLite authoritative for missing/stale projections and a filesystem-only AMD proposal", async () => {
    const runtime = await loadProgressRuntime();
    const fixture = newFixture();
    const { store, service } = await readyProgressService(runtime, fixture);
    const packageRoot = join(fixture.repositoryRoot, "docs/hybrid-flow-v1-r2");
    rmSync(join(packageRoot, "IMPLEMENTATION_PROGRESS.jsonl"), { force: true });
    rmSync(join(packageRoot, "IMPLEMENTATION_PROGRESS.md"), { force: true });
    expect(service.verify()).toMatchObject({
      status: "verified",
      authority: "sqlite",
      progressEventCount: 4,
      effectivePlanSha256: R2_PLAN_SHA256,
      projectionStatus: "pending",
    });

    writeFileSync(join(packageRoot, "IMPLEMENTATION_PROGRESS.jsonl"), "{\"sequence\":99}\n");
    writeFileSync(join(packageRoot, "IMPLEMENTATION_PROGRESS.md"), "# forged\n\n- [x] STG-12\n");
    amendmentFixture(fixture);
    expect(service.verify()).toMatchObject({
      status: "verified",
      authority: "sqlite",
      progressEventCount: 4,
      effectivePlanSha256: R2_PLAN_SHA256,
      projectionStatus: "stale",
    });
    expect(progressRows(fixture.databasePath).events).toHaveLength(4);
    store.close();
  });
});

function t11GraphFixture(): JsonObject {
  const definition = {
    schemaVersion: "GraphFlow/v1",
    flowId: "t11-valid-fixture",
    taskId: "t11-task",
    project: "/repo",
    origin: "codex",
    budget: {
      maxNodes: 4,
      maxActiveReadOnly: 2,
      maxChildDepth: 2,
      maxTokens: 10_000,
      maxWallTimeMs: 60_000,
      maxCostMicrousd: 250_000,
    },
    nodes: [
      {
        nodeId: "root",
        stageKind: "coordination",
        role: "coordinator",
        approvalScope: "workspace-read",
        promptTemplateRef: "prompt:t11-root",
        artifactRef: "artifact:t11-root",
        inputPorts: [],
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["route"],
          properties: { route: { type: "string", enum: ["continue"] } },
        },
        joinPolicy: "all_success",
        allowedRoutes: ["continue"],
        timeoutMs: 30_000,
        maxAttempts: 1,
        requestedTokenLimit: 2_000,
      },
      {
        nodeId: "terminal",
        stageKind: "testing",
        role: "tester",
        approvalScope: "workspace-read",
        promptTemplateRef: "prompt:t11-terminal",
        artifactRef: "artifact:t11-terminal",
        inputPorts: [],
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["passed"],
          properties: { passed: { type: "boolean" } },
        },
        joinPolicy: "all_success",
        allowedRoutes: [],
        timeoutMs: 30_000,
        maxAttempts: 1,
        requestedTokenLimit: 2_000,
      },
    ],
    edges: [{
      edgeId: "root-terminal",
      sourceId: "root",
      targetId: "terminal",
      condition: { kind: "route", routes: ["continue"] },
    }],
  };
  return { ...definition, definitionSha256: computeGraphDefinitionSha256(definition) };
}

function t11ExecutionSnapshot(databasePath: string): string {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  const tables = [
    "runs",
    "collaboration_dispatch_outbox",
    "graph_flows",
    "graph_nodes",
    "graph_edges",
    "graph_edge_evaluations",
    "graph_node_admission_intents",
    "graph_node_attempts",
    "graph_node_admissions",
    "graph_node_input_bindings",
    "graph_node_results",
    "graph_budget_reservations",
    "graph_budget_settlements",
    "agent_sessions",
    "agent_events",
    "agent_event_payloads",
    "agent_attempt_usage",
    "agent_usage_coverage",
    "agent_event_archives",
    "agent_event_archive_members",
  ] as const;
  try {
    return canonicalJson(Object.fromEntries(tables.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ])));
  } finally {
    db.close();
  }
}

describe("T11 unchanged execution surfaces", () => {
  it("keeps a valid graph fixture inert across RunStore, worker, service, MCP, and CLI", async () => {
    const fixture = newFixture();
    rmSync(fixture.databasePath);
    initializeCurrentExecutionSchema(fixture.databasePath);
    const definition = t11GraphFixture();
    const graphStore = new GraphFlowStore(fixture.databasePath);
    expect(graphStore.submit({ definition, requester: "t11-contract", now: AMD_ACCEPTED_AT })).toMatchObject({
      flowId: "t11-valid-fixture",
      status: "submitted",
      replayed: false,
    });
    graphStore.close();
    const inert = t11ExecutionSnapshot(fixture.databasePath);

    let runStore = new RunStore(fixture.databasePath);
    expect(runStore.list()).toEqual([]);
    expect(runStore.claimNext({ workerId: "t11-run-store", leaseMs: 1_000, now: AMD_ACCEPTED_AT + 1 })).toBeUndefined();
    runStore.close();
    expect(t11ExecutionSnapshot(fixture.databasePath)).toBe(inert);

    runStore = new RunStore(fixture.databasePath);
    let runnerCalls = 0;
    const worker = new DurableWorker({
      store: runStore,
      workerId: "t11-worker",
      runner: async () => {
        runnerCalls += 1;
        return { kind: "success" };
      },
    });
    expect(await worker.runOnce(AMD_ACCEPTED_AT + 2)).toBeUndefined();
    expect(runnerCalls).toBe(0);
    worker.close();
    expect(t11ExecutionSnapshot(fixture.databasePath)).toBe(inert);

    const service = new LocalCollabService(fixture.databasePath, { historyDatabase: fixture.historyPath });
    expect(await service.validateFlow(definition)).toEqual({
      schemaVersion: "GraphFlowValidation/v1",
      flowId: "t11-valid-fixture",
      nodeCount: 2,
      edgeCount: 1,
      valid: true,
    });
    expect(t11ExecutionSnapshot(fixture.databasePath)).toBe(inert);

    const server = createCollabMcpServer(service);
    const client = new Client({ name: "t11-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).not.toEqual(expect.arrayContaining([
        "collab_flow_submit",
        "collab_flow_start",
        "collab_flow_run",
        "collab_flow_execute",
        "collab_telemetry_append",
      ]));
      const result = await client.callTool({
        name: "collab_flow_validate",
        arguments: { definition },
      });
      expect(result.isError).not.toBe(true);
      expect(t11ExecutionSnapshot(fixture.databasePath)).toBe(inert);
    } finally {
      await client.close();
      await server.close();
      service.close();
    }

    const beforeCliDatabase = sqliteSnapshot(fixture.databasePath);
    const beforeCliFiles = readdirSync(fixture.stateRoot).sort();
    const cli = spawnSync(process.execPath, [resolve("scripts/agent-collab-launcher.mjs"), "flow-run"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, AGENT_COLLAB_STATE_DIR: fixture.stateRoot },
      timeout: 10_000,
    });
    expect(cli.status).not.toBe(0);
    expect(cli.stderr).toMatch(/unknown command:\s*flow-run/i);
    expect(sqliteSnapshot(fixture.databasePath)).toEqual(beforeCliDatabase);
    expect(readdirSync(fixture.stateRoot).sort()).toEqual(beforeCliFiles);
    expect(t11ExecutionSnapshot(fixture.databasePath)).toBe(inert);
  });
});

interface ProjectorWorkerHandle {
  readonly ready: Promise<void>;
  readonly done: Promise<{ watermarkSequence: number; watermarkEventSha256: string }>;
  go(): void;
  release(): void;
  terminate(): Promise<number>;
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${label} timed out`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error: unknown) => { clearTimeout(timer); rejectPromise(error); },
    );
  });
}

function waitForAtomic(control: Int32Array, index: number, label: string): Promise<void> {
  if (Atomics.load(control, index) === 1) return Promise.resolve();
  return new Promise<void>((resolveWait, rejectWait) => {
    const deadline = Date.now() + 15_000;
    const timer = setInterval(() => {
      if (Atomics.load(control, index) === 1) {
        clearInterval(timer);
        resolveWait();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        rejectWait(new Error(`${label} timed out`));
      }
    }, 5);
  });
}

function projectorWorker(input: {
  fixture: ProgressFixture;
  label: string;
  control: SharedArrayBuffer;
  goIndex: number;
  signalIndex: number;
  releaseIndex: number;
  pausePoint: string;
  signalOnlyPoint?: string;
  signalOnlyIndex?: number;
}): ProjectorWorkerHandle {
  const sourcePath = join(input.fixture.root, `projector-${input.label}.mts`);
  const storeUrl = pathToFileURL(resolve("src/store/implementation-progress-store.ts")).href;
  const filesUrl = pathToFileURL(resolve("src/store/implementation-progress-projection-files.ts")).href;
  const projectorUrl = pathToFileURL(resolve("src/app/implementation-progress-projector.ts")).href;
  writeFileSync(sourcePath, `
    import { parentPort, workerData } from "node:worker_threads";
    import { ImplementationProgressStore } from ${JSON.stringify(storeUrl)};
    import { ImplementationProgressProjectionFiles } from ${JSON.stringify(filesUrl)};
    import { ImplementationProgressProjector } from ${JSON.stringify(projectorUrl)};
    const control = new Int32Array(workerData.control);
    parentPort.postMessage({ type: "ready" });
    Atomics.wait(control, workerData.goIndex, 0);
    const store = new ImplementationProgressStore(workerData.databasePath);
    try {
      const files = new ImplementationProgressProjectionFiles({
        packageRoot: workerData.packageRoot,
        stateRoot: workerData.stateRoot,
      });
      const projector = new ImplementationProgressProjector({
        store,
        files,
        stateRoot: workerData.stateRoot,
        faultInjector(point) {
          if (point === workerData.signalOnlyPoint) {
            Atomics.store(control, workerData.signalOnlyIndex, 1);
            Atomics.notify(control, workerData.signalOnlyIndex);
          }
          if (point === workerData.pausePoint) {
            Atomics.store(control, workerData.signalIndex, 1);
            Atomics.notify(control, workerData.signalIndex);
            Atomics.wait(control, workerData.releaseIndex, 0);
          }
        },
      });
      const value = projector.project({ publishedAt: 1780000002000 });
      parentPort.postMessage({ type: "done", value });
    } catch (error) {
      parentPort.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) });
    } finally {
      store.close();
    }
  `, { mode: 0o600 });
  const worker = new Worker(pathToFileURL(sourcePath), {
    execArgv: ["--import", "tsx"],
    workerData: {
      databasePath: input.fixture.databasePath,
      packageRoot: join(input.fixture.repositoryRoot, "docs/hybrid-flow-v1-r2"),
      stateRoot: input.fixture.stateRoot,
      control: input.control,
      goIndex: input.goIndex,
      signalIndex: input.signalIndex,
      releaseIndex: input.releaseIndex,
      pausePoint: input.pausePoint,
      signalOnlyPoint: input.signalOnlyPoint,
      signalOnlyIndex: input.signalOnlyIndex,
    },
  });
  let readyResolve!: () => void;
  let doneResolve!: (value: { watermarkSequence: number; watermarkEventSha256: string }) => void;
  let doneReject!: (error: Error) => void;
  const ready = withTimeout(new Promise<void>((resolveReady) => { readyResolve = resolveReady; }), `${input.label} ready`);
  const done = withTimeout(new Promise<{ watermarkSequence: number; watermarkEventSha256: string }>((resolveDone, rejectDone) => {
    doneResolve = resolveDone;
    doneReject = rejectDone;
  }), `${input.label} done`);
  void done.catch(() => undefined);
  worker.on("message", (message: {
    type: "ready" | "done" | "error";
    value?: { watermarkSequence: number; watermarkEventSha256: string };
    error?: string;
  }) => {
    if (message.type === "ready") readyResolve();
    else if (message.type === "done" && message.value) doneResolve(message.value);
    else if (message.type === "error") doneReject(new Error(message.error ?? "projector worker failed"));
  });
  worker.on("error", doneReject);
  worker.on("exit", (code) => {
    if (code !== 0) doneReject(new Error(`projector worker exited with code ${code}`));
  });
  return {
    ready,
    done,
    go: () => {
      Atomics.store(new Int32Array(input.control), input.goIndex, 1);
      Atomics.notify(new Int32Array(input.control), input.goIndex);
    },
    release: () => {
      Atomics.store(new Int32Array(input.control), input.releaseIndex, 1);
      Atomics.notify(new Int32Array(input.control), input.releaseIndex);
    },
    terminate: () => worker.terminate(),
  };
}

function projectedSequence(fixture: ProgressFixture): number {
  const path = join(fixture.repositoryRoot, "docs/hybrid-flow-v1-r2/IMPLEMENTATION_PROGRESS.jsonl");
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  return Number((JSON.parse(lines.at(-1)!) as JsonObject).sequence);
}

describe("filesystem-only progress projection and projector coordination", () => {
  it("publishes and rereads both files without any SQL authority or DB mutation in the file adapter", async () => {
    const projection = await loadProjectionRuntime();
    const fixture = newFixture();
    await migrateFixture(fixture);
    const before = progressTableSnapshot(fixture.databasePath);
    const files = new projection.Files({
      packageRoot: join(fixture.repositoryRoot, "docs/hybrid-flow-v1-r2"),
      stateRoot: fixture.stateRoot,
    });
    const events = progressRows(fixture.databasePath).events.map(({ event_json }) => JSON.parse(String(event_json)) as JsonObject);
    const jsonlBytes = Buffer.from(`${events.map(canonicalJson).join("\n")}\n`);
    const markdownBytes = Buffer.from(`# Verified implementation progress\n\nVerified events: ${events.length}\n`);
    const result = files.publish({
      jsonlBytes,
      markdownBytes,
      watermarkSequence: 3,
      watermarkEventSha256: String(events[2]!.eventSha256),
    });
    expect(readFileSync(result.jsonlPath)).toEqual(jsonlBytes);
    expect(readFileSync(result.markdownPath)).toEqual(markdownBytes);
    expect(() => files.verify({ watermarkSequence: 3, watermarkEventSha256: String(events[2]!.eventSha256) }))
      .not.toThrow();
    expect(progressTableSnapshot(fixture.databasePath)).toBe(before);
  });

  it("uses deterministic ready/go/snapshot barriers so W4 cannot overwrite W6 in a two-projector race", async () => {
    const [runtime, amendmentRuntime] = await Promise.all([loadProgressRuntime(), loadAmendmentRuntime()]);
    const fixture = newFixture();
    const ready = await readyProgressService(runtime, fixture);
    ready.store.close();
    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 8);
    const control = new Int32Array(shared);
    const first = projectorWorker({
      fixture,
      label: "first",
      control: shared,
      goIndex: 0,
      signalIndex: 1,
      releaseIndex: 2,
      pausePoint: "after_projection_files_verified",
    });
    let second: ProjectorWorkerHandle | undefined;
    try {
      await first.ready;
      first.go();
      await waitForAtomic(control, 1, "first W4 files");
      expect(projectedSequence(fixture)).toBe(4);

      const amd = amendmentFixture(fixture);
      const issued = issuedAmendmentAuthority(amendmentRuntime, fixture, amd);
      const amdStore = await newProgressStore(runtime, fixture, { amendmentAuthority: issued.authority });
      serviceFor(runtime, fixture, amdStore, issued.authority)
        .acceptAmendment(amendmentRequest(amd), issued.capability);
      amdStore.close();
      expect(progressRows(fixture.databasePath).outbox.filter(({ published_at }) => published_at === null)).toHaveLength(6);

      second = projectorWorker({
        fixture,
        label: "second",
        control: shared,
        goIndex: 3,
        signalIndex: 4,
        releaseIndex: 5,
        pausePoint: "after_projection_snapshot",
        signalOnlyPoint: "before_projection_lock_acquire",
        signalOnlyIndex: 6,
      });
      await second.ready;
      second.go();
      await waitForAtomic(control, 6, "second lock attempt");
      expect(Atomics.load(control, 4)).toBe(0);

      first.release();
      expect(await first.done).toMatchObject({ watermarkSequence: 4, watermarkEventSha256: STG03_EVENT_SHA256 });
      await waitForAtomic(control, 4, "second W6 snapshot");
      expect(projectedSequence(fixture)).toBe(4);
      expect(progressRows(fixture.databasePath).outbox
        .filter(({ published_at }) => published_at === null)
        .map(({ projection_payload_json }) =>
          (JSON.parse(String(projection_payload_json)) as JsonObject).sequence)).toEqual([5, 6]);

      second.release();
      expect(await second.done).toMatchObject({ watermarkSequence: 6 });
      expect(projectedSequence(fixture)).toBe(6);
      expect(progressRows(fixture.databasePath).outbox.filter(({ published_at }) => published_at === null)).toEqual([]);
    } finally {
      first.release();
      second?.release();
      await Promise.allSettled([first.terminate(), ...(second ? [second.terminate()] : [])]);
    }
  }, 30_000);

  it.each([
    "after_jsonl_temp_write",
    "after_jsonl_file_fsync",
    "after_jsonl_rename",
    "after_jsonl_directory_fsync",
    "after_markdown_temp_write",
    "after_markdown_file_fsync",
    "after_markdown_rename",
    "after_markdown_directory_fsync",
  ])("keeps each file atomic and outbox pending at %s, then releases the lock for exact replay", async (faultPoint) => {
    const [runtime, projection] = await Promise.all([loadProgressRuntime(), loadProjectionRuntime()]);
    const fixture = newFixture();
    const ready = await readyProgressService(runtime, fixture);
    ready.store.close();
    const packageRoot = join(fixture.repositoryRoot, "docs/hybrid-flow-v1-r2");
    const jsonlPath = join(packageRoot, "IMPLEMENTATION_PROGRESS.jsonl");
    const markdownPath = join(packageRoot, "IMPLEMENTATION_PROGRESS.md");
    const beforeFiles = {
      jsonl: readFileSync(jsonlPath),
      markdown: readFileSync(markdownPath),
    };
    const beforeDatabase = progressTableSnapshot(fixture.databasePath);
    let store = await newProgressStore(runtime, fixture);
    let files = new projection.Files({
      packageRoot,
      stateRoot: fixture.stateRoot,
      faultInjector: (point) => {
        if (point === faultPoint) throw new Error(`injected ${faultPoint}`);
      },
    });
    let projector = new projection.Projector({ store, files, stateRoot: fixture.stateRoot });
    expect(() => projector.project({ publishedAt: AMD_ACCEPTED_AT + 1_000 }))
      .toThrow(new RegExp(faultPoint));
    store.close();
    const interruptedFiles = {
      jsonl: readFileSync(jsonlPath),
      markdown: readFileSync(markdownPath),
    };
    expect(progressTableSnapshot(fixture.databasePath)).toBe(beforeDatabase);
    expect(progressRows(fixture.databasePath).outbox.every(({ published_at }) => published_at === null)).toBe(true);

    store = await newProgressStore(runtime, fixture);
    files = new projection.Files({ packageRoot, stateRoot: fixture.stateRoot });
    projector = new projection.Projector({ store, files, stateRoot: fixture.stateRoot });
    expect(projector.project({ publishedAt: AMD_ACCEPTED_AT + 2_000 })).toMatchObject({
      watermarkSequence: 4,
      watermarkEventSha256: STG03_EVENT_SHA256,
    });
    store.close();
    const replayedFiles = {
      jsonl: readFileSync(jsonlPath),
      markdown: readFileSync(markdownPath),
    };
    expect([beforeFiles.jsonl, replayedFiles.jsonl]).toContainEqual(interruptedFiles.jsonl);
    expect([beforeFiles.markdown, replayedFiles.markdown]).toContainEqual(interruptedFiles.markdown);
    expect(projectedSequence(fixture)).toBe(4);
    expect(replayedFiles.markdown.toString("utf8")).toMatch(/Verified events:\s*4/i);
    expect(progressRows(fixture.databasePath).outbox.every(({ published_at }) => published_at !== null)).toBe(true);
    expect(readdirSync(packageRoot).filter((name) => /\.tmp(?:\.|$)/.test(name))).toEqual([]);
  });

  it("fails closed when a verified projection path is swapped to a symlink before outbox marking", async () => {
    const [runtime, projection] = await Promise.all([loadProgressRuntime(), loadProjectionRuntime()]);
    const fixture = newFixture();
    const ready = await readyProgressService(runtime, fixture);
    ready.store.close();
    const packageRoot = join(fixture.repositoryRoot, "docs/hybrid-flow-v1-r2");
    const jsonlPath = join(packageRoot, "IMPLEMENTATION_PROGRESS.jsonl");
    const outside = join(fixture.root, "post-validation-outside.jsonl");
    writeFileSync(outside, "outside remains unchanged\n");
    let swapped = false;
    let store = await newProgressStore(runtime, fixture);
    let files = new projection.Files({ packageRoot, stateRoot: fixture.stateRoot });
    let projector = new projection.Projector({
      store,
      files,
      stateRoot: fixture.stateRoot,
      faultInjector(point) {
        if (point === "after_projection_files_verified" && !swapped) {
          swapped = true;
          rmSync(jsonlPath);
          symlinkSync(outside, jsonlPath);
        }
      },
    });
    expect(() => projector.project({ publishedAt: AMD_ACCEPTED_AT + 3_000 }))
      .toThrow(/symlink|path|regular file|nofollow|revalidation|identity|TOCTOU/i);
    store.close();
    expect(swapped).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("outside remains unchanged\n");
    expect(progressRows(fixture.databasePath).outbox.every(({ published_at }) => published_at === null)).toBe(true);

    rmSync(jsonlPath);
    store = await newProgressStore(runtime, fixture);
    files = new projection.Files({ packageRoot, stateRoot: fixture.stateRoot });
    projector = new projection.Projector({ store, files, stateRoot: fixture.stateRoot });
    expect(projector.project({ publishedAt: AMD_ACCEPTED_AT + 4_000 })).toMatchObject({ watermarkSequence: 4 });
    store.close();
    expect(projectedSequence(fixture)).toBe(4);
    expect(readFileSync(outside, "utf8")).toBe("outside remains unchanged\n");
    expect(progressRows(fixture.databasePath).outbox.every(({ published_at }) => published_at !== null)).toBe(true);
  });

  it("fails closed on reread corruption and symlink replacement without marking the outbox", async () => {
    const [runtime, projection] = await Promise.all([loadProgressRuntime(), loadProjectionRuntime()]);
    const corrupted = newFixture();
    let ready = await readyProgressService(runtime, corrupted);
    ready.store.close();
    const corruptedRoot = join(corrupted.repositoryRoot, "docs/hybrid-flow-v1-r2");
    let changed = false;
    let store = await newProgressStore(runtime, corrupted);
    let files = new projection.Files({
      packageRoot: corruptedRoot,
      stateRoot: corrupted.stateRoot,
      faultInjector: (point) => {
        if (point === "before_projection_reread" && !changed) {
          changed = true;
          writeFileSync(join(corruptedRoot, "IMPLEMENTATION_PROGRESS.jsonl"), "corrupt\n");
        }
      },
    });
    let projector = new projection.Projector({ store, files, stateRoot: corrupted.stateRoot });
    expect(() => projector.project({ publishedAt: AMD_ACCEPTED_AT + 3_000 }))
      .toThrow(/reread|corrupt|watermark|digest/i);
    store.close();
    expect(progressRows(corrupted.databasePath).outbox.every(({ published_at }) => published_at === null)).toBe(true);

    const linked = newFixture();
    ready = await readyProgressService(runtime, linked);
    ready.store.close();
    const linkedRoot = join(linked.repositoryRoot, "docs/hybrid-flow-v1-r2");
    const outside = join(linked.root, "outside.jsonl");
    writeFileSync(outside, "outside stays unchanged\n");
    rmSync(join(linkedRoot, "IMPLEMENTATION_PROGRESS.jsonl"), { force: true });
    symlinkSync(outside, join(linkedRoot, "IMPLEMENTATION_PROGRESS.jsonl"));
    store = await newProgressStore(runtime, linked);
    files = new projection.Files({ packageRoot: linkedRoot, stateRoot: linked.stateRoot });
    projector = new projection.Projector({ store, files, stateRoot: linked.stateRoot });
    expect(() => projector.project({ publishedAt: AMD_ACCEPTED_AT + 4_000 }))
      .toThrow(/symlink|path|regular file|nofollow/i);
    store.close();
    expect(readFileSync(outside, "utf8")).toBe("outside stays unchanged\n");
    expect(progressRows(linked.databasePath).outbox.every(({ published_at }) => published_at === null)).toBe(true);
  });
});
