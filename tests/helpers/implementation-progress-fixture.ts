import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import canonicalize from "canonicalize";

import { initializeCurrentExecutionSchema } from "../../src/migration/coordinator.js";
import { dropGraphV4Schema, dropReviewV3Extension } from "./graph-schema.js";

export const REVIEWED_COMMIT = "cf0f1801cd21f3368a0572a6dcd6937f9fc3fb50";
export const REVIEWED_TREE = "955260b898f2465b72ecaabcb43b1453a15e3ebc";
export const REVIEWED_LAST_EVENT_SHA256 = "924887cd4205a7b5b9a9fabad426162d32c3ec6da886eff24b8bc074ba0c5469";
export const R2_PLAN_ID = "agent-collab-hybrid-flow-v1-r2";
export const R2_PLAN_SHA256 = "af9191ea30d500de7f53cfdb57a890bfc7c1e55df3d3e738ed667bce7a787224";
export const R2_START_SHA256 = "851b7136b5642360481b9896b154745bb8bee06adcc0017058cd964add396aee";
export const STG03_EVENT_SHA256 = "6685e9a79886b7f895fb4533b2f95d5c03e3a544bc3c4a99b48b6d46527bf12d";
export const AMD_AUTHORIZATION_CAPTURED_AT = "2026-09-04T17:08:05+08:00";
export const AMD_RECORDED_AT = "2026-09-04T17:09:00+08:00";
export const AMD_ACCEPTED_AT = Date.parse("2026-09-04T17:10:00+08:00");
export const AMD_AUTHORIZATION_TEXT_SHA256 = "5afaede6548ebf2b62086bdda12eb54880e6a8681e6279915728fa71184db683";
export const AMD_ARCHITECTURE_EVIDENCE_SHA256 = "47c39470257d5e1e8c8018628494b77aece3461c04c2a99c6ad559b5261d5523";
export const AMD_STG03_SOURCE_MANIFEST_SHA256 = "77aded37d2f062601b5bf40dcd284052db90bb2d31b4e44746891f0737acd6a8";

// Literal trust pins: fixture construction must match these independent values.
export const AMD_AUTHORITY_RECEIPT_SHA256 = "e5a76fdbc55a8b584bebaa842a958418a896853ffb5be08725c7abdccfacf1a3";
export const AMD_AUTHORITY_RECEIPT_FILE_SHA256 = "8d3d62db9434f3a5ae422a36b9d76fe9234287363740ba4c7a7994ca930c2562";
export const AMD_FILE_SHA256 = "5ea6ba681c0b0d7567d248441924e6e602982fca283d0fbaea27bf7a0c92c685";
export const AMD_EFFECTIVE_PLAN_SHA256 = "910df47ec6d48ce31424b9935816c0a180b4a9ae1539bf9d052f788dea922102";

export const REVIEWED_FILES = [
  "docs/hybrid-flow-v1-r2/IMPLEMENTATION_START.json",
  "docs/hybrid-flow-v1-r2/PLAN_LOCK.json",
  "docs/hybrid-flow-v1-r2/stage-close/pre-v4/000001-r2-stg-00-pass.json",
  "docs/hybrid-flow-v1-r2/stage-close/pre-v4/000002-stg-01-pass.json",
  "docs/hybrid-flow-v1-r2/stage-close/pre-v4/000003-stg-02-pass.json",
  "docs/hybrid-flow-v1/STATE_V4_SCHEMA.sql",
  "scripts/verify-implementation-progress.mjs",
  "src/migration/coordinator.ts",
] as const;

export const AMD_CONTRACT_DELTA = {
  "STG-04": {
    add: [
      "bounded_post_commit_telemetry_export",
      "graph_fixture_event_session_usage_persistence",
      "provider_terminal_usage_normalization_and_observation_transport",
      "terminal_flow_payload_archival",
    ],
    deferToStage: {
      stageId: "STG-08",
      capabilities: [
        "graph_transition_and_telemetry_atomicity",
        "runstore_worker_service_cli_telemetry_execution_wiring",
      ],
    },
  },
  "STG-08": {
    add: [
      "graph_transition_and_telemetry_atomicity",
      "runstore_worker_service_cli_telemetry_execution_wiring",
    ],
  },
} as const;

export const AMD_ACCEPTANCE_DELTA = {
  replace: [
    {
      gateId: "STG-04-G1",
      from: "Usage provenance and aggregation tests pass.",
      to: "Graph-fixture event, session, and usage persistence, provider normalization, provenance, aggregation, and crash/replay tests pass.",
    },
    {
      gateId: "STG-04-G2",
      from: "Redaction, archival, and exporter-failure tests pass.",
      to: "Redaction, archival, bounded detached exporter-failure, and legacy zero-effect tests pass; execution wiring remains unchanged.",
    },
  ],
  augment: [
    {
      gateId: "STG-08-G1",
      text: "Execution wiring proves transition-plus-telemetry atomicity and crash/replay safety.",
    },
    {
      gateId: "STG-08-G2",
      text: "No duplicate session, event, usage, or terminal receipt is permitted.",
    },
  ],
} as const;

export const AMD_AUTHORITY_DELTA = {
  approval: "unchanged",
  safety: "unchanged",
  routingV5: "unchanged",
  reviewQuorum: "unchanged",
  liveProviderLaunchCap: "unchanged",
  migration: "not_authorized",
  deployment: "not_authorized",
  providerLaunch: "not_authorized",
  graphActivation: "not_authorized",
  legacyActivation: "not_authorized",
} as const;

export type JsonObject = Record<string, unknown>;

export interface ProgressFixture {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly stateRoot: string;
  readonly databasePath: string;
  readonly historyPath: string;
}

export interface ArtifactFact {
  readonly path: string;
  readonly bytes: Buffer;
}

export interface TrustedAmendmentAuthority {
  readonly schemaVersion: "trusted-amendment-authority/v1";
  readonly consumer: string;
  readonly expectedReceiptSha256: string;
  readonly authorizationTextSha256: string;
}

export interface AmendmentFixture {
  readonly amendment: JsonObject;
  readonly amendmentBytes: Buffer;
  readonly amendmentPath: string;
  readonly amendmentFileSha256: string;
  readonly authorityReceipt: JsonObject;
  readonly authorityReceiptBytes: Buffer;
  readonly authorityReceiptPath: string;
  readonly authorityReceiptFileSha256: string;
  readonly evidenceArtifacts: readonly ArtifactFact[];
  readonly authorizationTextBytes: Buffer;
  readonly trustedAuthority: TrustedAmendmentAuthority;
  readonly effectivePlanSha256: string;
}

export interface ProgressRows {
  readonly events: JsonObject[];
  readonly outbox: JsonObject[];
}

export function canonicalJson(value: unknown): string {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new Error("fixture value is not canonicalizable");
  return encoded;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function withCanonicalHash(value: JsonObject, field: string): JsonObject {
  const withoutDigest = { ...value };
  delete withoutDigest[field];
  return { ...withoutDigest, [field]: sha256(canonicalJson(withoutDigest)) };
}

function seedHistoryV2(path: string): void {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE sources (
        project TEXT NOT NULL,
        source_path TEXT NOT NULL,
        agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex', 'claude_legacy')),
        checkpoint_offset INTEGER NOT NULL,
        checkpoint_line INTEGER NOT NULL,
        prefix_hash TEXT NOT NULL,
        session_id TEXT,
        PRIMARY KEY (project, source_path)
      );
      CREATE TABLE history_rows (
        project TEXT NOT NULL,
        source_path TEXT NOT NULL,
        record_key TEXT NOT NULL,
        source_agent TEXT NOT NULL CHECK (source_agent IN ('grok', 'codex', 'claude_legacy')),
        namespace TEXT NOT NULL CHECK (namespace IN ('grok_native', 'codex_native', 'claude_legacy', 'collaboration_shared')),
        kind TEXT NOT NULL CHECK (kind IN ('memory', 'message', 'tool_summary')),
        session_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('assistant', 'memory', 'user')),
        content TEXT NOT NULL,
        source_line INTEGER NOT NULL,
        timestamp TEXT,
        content_hash TEXT NOT NULL,
        trust TEXT NOT NULL CHECK (trust = 'untrusted'),
        PRIMARY KEY (project, source_path, record_key)
      );
      CREATE INDEX history_rows_project ON history_rows(project, source_agent, source_path, source_line);
      CREATE TABLE pending_tools (
        project TEXT NOT NULL,
        source_path TEXT NOT NULL,
        call_id TEXT NOT NULL,
        agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex', 'claude_legacy')),
        name TEXT NOT NULL,
        session_id TEXT,
        source_line INTEGER NOT NULL,
        timestamp TEXT,
        record_key TEXT NOT NULL,
        PRIMARY KEY (project, source_path, call_id)
      );
      CREATE TABLE history_issues (
        project TEXT NOT NULL,
        source_path TEXT NOT NULL,
        code TEXT NOT NULL,
        source_line INTEGER NOT NULL DEFAULT -1,
        details TEXT,
        PRIMARY KEY (project, source_path, code, source_line)
      );
      CREATE TABLE memory_source_health (
        project TEXT NOT NULL,
        namespace TEXT NOT NULL CHECK (namespace IN ('grok_native', 'codex_native')),
        status TEXT NOT NULL CHECK (status IN ('projected', 'unavailable', 'no_project_section')),
        source_path TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project, namespace)
      );
      INSERT INTO sources VALUES ('/repo', '/repo/codex.jsonl', 'codex', 7, 1, 'abc', 'session');
      PRAGMA user_version = 2;
    `);
  } finally {
    db.close();
  }
}

function downgradeFreshStateToV3(path: string): void {
  initializeCurrentExecutionSchema(path);
  dropReviewV3Extension(path);
  dropGraphV4Schema(path);
  const db = new Database(path);
  try {
    const columns = db.prepare("PRAGMA table_info(runtime_review_barriers)").all() as Array<{ name: string }>;
    db.exec(`
      DROP TRIGGER IF EXISTS runtime_review_attempt_v2_insert;
      DROP TRIGGER IF EXISTS runtime_review_attempt_v2_update;
      DROP TRIGGER IF EXISTS runtime_review_barrier_v2_update;
      ${columns.some(({ name }) => name === "launch_authority_version")
        ? "ALTER TABLE runtime_review_barriers DROP COLUMN launch_authority_version;"
        : ""}
      PRAGMA user_version = 3;
    `);
  } finally {
    db.close();
  }
}

export function createProgressFixture(): ProgressFixture {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-progress-v4-"));
  const repositoryRoot = join(root, "repository");
  const stateRoot = join(root, "state");
  mkdirSync(repositoryRoot);
  mkdirSync(stateRoot);
  cpSync(resolve("docs"), join(repositoryRoot, "docs"), { recursive: true });
  cpSync(resolve("repo-c4.json"), join(repositoryRoot, "repo-c4.json"));
  const databasePath = join(stateRoot, "collaboration.db");
  const historyPath = join(stateRoot, "history.db");
  downgradeFreshStateToV3(databasePath);
  seedHistoryV2(historyPath);
  return { root, repositoryRoot, stateRoot, databasePath, historyPath };
}

export function removeProgressFixture(fixture: ProgressFixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

export function readR2ProgressEvent(sequence: number): JsonObject {
  const root = resolve("docs/hybrid-flow-v1-r2/stage-close/pre-v4");
  const names = [
    "000001-r2-stg-00-pass.json",
    "000002-stg-01-pass.json",
    "000003-stg-02-pass.json",
    "000004-stg-03-pass.json",
  ];
  const name = names[sequence - 1];
  if (!name) throw new Error(`no immutable R2 fixture event at sequence ${sequence}`);
  return JSON.parse(readFileSync(join(root, name), "utf8")) as JsonObject;
}

function normalizeSqliteValue(value: unknown): unknown {
  return Buffer.isBuffer(value) ? { $buffer: value.toString("base64") } : value;
}

export function sqliteSnapshot(databasePath: string): JsonObject {
  if (!existsSync(databasePath)) return { exists: false };
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const tables = db.prepare(`SELECT name,sql FROM sqlite_schema
      WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{
        name: string;
        sql: string;
      }>;
    return {
      exists: true,
      userVersion: Number(db.pragma("user_version", { simple: true })),
      integrity: db.pragma("integrity_check"),
      foreignKeys: db.pragma("foreign_key_check"),
      tables: tables.map(({ name, sql }) => ({
        name,
        sql,
        rows: (db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all() as JsonObject[])
          .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeSqliteValue(value)]))),
      })),
    };
  } finally {
    db.close();
  }
}

function fileSnapshot(root: string): JsonObject[] {
  if (!existsSync(root)) return [];
  const result: JsonObject[] = [];
  const visit = (path: string): void => {
    for (const name of readdirSync(path).sort()) {
      const target = join(path, name);
      const stat = lstatSync(target);
      const entry = relative(root, target);
      if (stat.isDirectory()) visit(target);
      else if (stat.isSymbolicLink()) result.push({ path: entry, type: "symlink" });
      else result.push({ path: entry, type: "file", mode: stat.mode & 0o777, sha256: sha256(readFileSync(target)) });
    }
  };
  visit(root);
  return result;
}

export function migrationSurfaceSnapshot(fixture: ProgressFixture): JsonObject {
  return {
    state: sqliteSnapshot(fixture.databasePath),
    history: sqliteSnapshot(fixture.historyPath),
    files: fileSnapshot(fixture.stateRoot),
  };
}

export function progressRows(databasePath: string): ProgressRows {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return {
      events: db.prepare("SELECT * FROM plan_progress_events ORDER BY sequence_no").all() as JsonObject[],
      outbox: db.prepare("SELECT * FROM plan_progress_outbox ORDER BY rowid").all() as JsonObject[],
    };
  } finally {
    db.close();
  }
}

export function progressTableSnapshot(databasePath: string): string {
  return canonicalJson(progressRows(databasePath));
}

export function artifactFacts(repositoryRoot: string, paths: readonly string[]): ArtifactFact[] {
  return [...paths].sort().map((path) => ({ path, bytes: readFileSync(join(repositoryRoot, path)) }));
}

export function eventArtifactFacts(repositoryRoot: string, events: readonly JsonObject[]): ArtifactFact[] {
  const paths = new Set<string>();
  for (const event of events) {
    for (const path of event.artifactPaths as string[]) paths.add(path);
  }
  return artifactFacts(repositoryRoot, [...paths]);
}

export function writeArtifact(repositoryRoot: string, path: string, bytes: Buffer | string): void {
  const target = join(repositoryRoot, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

export function rewriteLastEvent(
  fixture: ProgressFixture,
  mutate: (event: JsonObject) => void,
): JsonObject {
  return rewriteEventChain(fixture, 4, mutate)[3]!;
}

export function rewriteEventChain(
  fixture: ProgressFixture,
  startSequence: number,
  mutate: (event: JsonObject) => void,
): JsonObject[] {
  const db = new Database(fixture.databasePath);
  try {
    const events = (db.prepare("SELECT event_json FROM plan_progress_events ORDER BY sequence_no").pluck().all() as string[])
      .map((eventJson) => JSON.parse(eventJson) as JsonObject);
    if (startSequence < 1 || startSequence > events.length) throw new Error("invalid fixture rechain sequence");
    mutate(events[startSequence - 1]!);
    for (let index = startSequence - 1; index < events.length; index += 1) {
      const candidate = events[index]!;
      if (index > 0) candidate.previousEventSha256 = events[index - 1]!.eventSha256;
      events[index] = withCanonicalHash(candidate, "eventSha256");
    }
    db.transaction(() => {
      for (let index = startSequence - 1; index < events.length; index += 1) {
        const event = events[index]!;
        const eventJson = canonicalJson(event);
        db.prepare(`UPDATE plan_progress_events SET
          plan_id=@planId,event_id=@eventId,start_sha256=@startSha256,
          previous_event_sha256=@previousEventSha256,effective_plan_sha256=@effectivePlanSha256,
          event_json=@eventJson,event_sha256=@eventSha256,created_at=@createdAt WHERE sequence_no=@sequence`).run({
          ...event,
          eventJson,
          createdAt: Date.parse(String(event.recordedAt)),
        });
        db.prepare(`UPDATE plan_progress_outbox SET event_id=@eventId,projection_payload_json=@eventJson
          WHERE rowid=(SELECT rowid FROM plan_progress_outbox ORDER BY rowid LIMIT 1 OFFSET @offset)`).run({
          eventId: event.eventId,
          eventJson,
          offset: index,
        });
      }
    }).immediate();
    return events;
  } finally {
    db.close();
  }
}

export function rebindEventArtifact(event: JsonObject, path: string, bytes: Buffer): void {
  const digest = sha256(bytes);
  for (const field of ["inputHashes", "outputHashes"] as const) {
    const ref = (event[field] as JsonObject[]).find((candidate) => candidate.path === path);
    if (ref) ref.sha256 = digest;
  }
  const receipt = (event.reviewReceiptHashes as JsonObject[]).find((candidate) => candidate.artifactPath === path);
  if (receipt) receipt.sha256 = digest;
  const oracle = event.commandOrOracle as JsonObject;
  if (oracle.artifactPath === path) oracle.sha256 = digest;
}

export function amendmentFixture(fixture: ProgressFixture): AmendmentFixture {
  const reason = "Move graph-fixture telemetry into STG-04 while preserving disabled execution wiring until STG-08.";
  const architecturePath = "docs/hybrid-flow-v1-r2/amendments/evidence/architecture-slice.md";
  const sourceManifestPath = "docs/hybrid-flow-v1-r2/amendments/evidence/stg-03-source-manifest.json";
  const amendmentPath = "docs/hybrid-flow-v1-r2/amendments/AMD-0001.json";
  const authorityReceiptPath = "docs/hybrid-flow-v1-r2/amendments/AMD-0001-authority.json";
  const architecture = readFileSync(join(fixture.repositoryRoot, architecturePath));
  const sourceManifest = readFileSync(join(
    fixture.repositoryRoot,
    "docs/hybrid-flow-v1-r2/stage-close/STG-03-source-manifest.json",
  ));
  const authorizationTextBytes = Buffer.from("разрешаю оформить и принять AMD-0001 в указанном объёме", "utf8");
  if (sha256(authorizationTextBytes) !== AMD_AUTHORIZATION_TEXT_SHA256) {
    throw new Error("AMD authorization text bytes do not match the independent user-authority pin");
  }
  if (sha256(architecture) !== AMD_ARCHITECTURE_EVIDENCE_SHA256) {
    throw new Error("AMD architecture evidence bytes do not match the durable evidence pin");
  }
  if (sha256(sourceManifest) !== AMD_STG03_SOURCE_MANIFEST_SHA256) {
    throw new Error("AMD STG-03 source manifest bytes do not match the immutable source pin");
  }
  writeArtifact(fixture.repositoryRoot, sourceManifestPath, sourceManifest);
  const evidenceArtifacts = [
    { path: architecturePath, bytes: architecture },
    { path: sourceManifestPath, bytes: sourceManifest },
  ] as const;
  const evidence = evidenceArtifacts.map(({ path, bytes }) => ({ path, sha256: sha256(bytes) }));
  const consumer = "agent-collab:implementation-amendment:AMD-0001";
  const proposal = {
    schemaVersion: "implementation-amendment/v1",
    amendmentId: "AMD-0001",
    ordinal: 1,
    planId: R2_PLAN_ID,
    baselinePlanSha256: R2_PLAN_SHA256,
    previousEffectivePlanSha256: R2_PLAN_SHA256,
    affectedStageIds: ["STG-04", "STG-08"],
    affectedGateIds: ["STG-04-G1", "STG-04-G2", "STG-08-G1", "STG-08-G2"],
    reason,
    reasonSha256: sha256(canonicalJson(reason)),
    evidence,
    evidenceSha256: sha256(canonicalJson(evidence)),
    contractDelta: AMD_CONTRACT_DELTA,
    acceptanceDelta: AMD_ACCEPTANCE_DELTA,
    authorityDelta: AMD_AUTHORITY_DELTA,
    invalidatedEventIds: [],
    authorityConsumer: consumer,
    recordedAt: AMD_RECORDED_AT,
  };
  const proposalSha256 = sha256(canonicalJson(proposal));
  const authorityReceipt = {
    schemaVersion: "implementation-amendment-authority/v1",
    planId: R2_PLAN_ID,
    amendmentId: "AMD-0001",
    ordinal: 1,
    consumer,
    affectedStageIds: ["STG-04", "STG-08"],
    affectedGateIds: ["STG-04-G1", "STG-04-G2", "STG-08-G1", "STG-08-G2"],
    contractDeltaSha256: sha256(canonicalJson(AMD_CONTRACT_DELTA)),
    acceptanceDeltaSha256: sha256(canonicalJson(AMD_ACCEPTANCE_DELTA)),
    authorityDeltaSha256: sha256(canonicalJson(AMD_AUTHORITY_DELTA)),
    scope: {
      amendmentAcceptance: true,
      migration: false,
      deployment: false,
      providerLaunch: false,
      graphActivation: false,
      legacyActivation: false,
    },
    authorizationTextSha256: sha256(authorizationTextBytes),
    capturedAt: AMD_AUTHORIZATION_CAPTURED_AT,
    proposalSha256,
  };
  const authorityReceiptBytes = Buffer.from(`${canonicalJson(authorityReceipt)}\n`, "utf8");
  const authorityReceiptSha256 = sha256(canonicalJson(authorityReceipt));
  const amendment = withCanonicalHash({ ...proposal, authorityReceiptSha256 }, "amendmentSha256");
  const amendmentBytes = Buffer.from(`${canonicalJson(amendment)}\n`, "utf8");
  const amendmentFileSha256 = sha256(amendmentBytes);
  const effectivePlanSha256 = sha256(canonicalJson({
    baselinePlanSha256: R2_PLAN_SHA256,
    previousEffectivePlanSha256: R2_PLAN_SHA256,
    ordinal: 1,
    amendmentSha256: amendment.amendmentSha256,
  }));
  writeArtifact(fixture.repositoryRoot, amendmentPath, amendmentBytes);
  writeArtifact(fixture.repositoryRoot, authorityReceiptPath, authorityReceiptBytes);
  return {
    amendment,
    amendmentBytes,
    amendmentPath,
    amendmentFileSha256,
    authorityReceipt,
    authorityReceiptBytes,
    authorityReceiptPath,
    authorityReceiptFileSha256: sha256(authorityReceiptBytes),
    evidenceArtifacts,
    authorizationTextBytes,
    trustedAuthority: Object.freeze({
      schemaVersion: "trusted-amendment-authority/v1",
      consumer,
      expectedReceiptSha256: AMD_AUTHORITY_RECEIPT_SHA256,
      authorizationTextSha256: sha256(authorizationTextBytes),
    }),
    effectivePlanSha256,
  };
}

export function assertFixturePins(amd: AmendmentFixture): void {
  const receipt = sha256(canonicalJson(amd.authorityReceipt));
  if (receipt !== AMD_AUTHORITY_RECEIPT_SHA256) throw new Error(`authority receipt pin mismatch: ${receipt}`);
  if (amd.authorityReceiptFileSha256 !== AMD_AUTHORITY_RECEIPT_FILE_SHA256) {
    throw new Error(`authority receipt file pin mismatch: ${amd.authorityReceiptFileSha256}`);
  }
  if (amd.amendmentFileSha256 !== AMD_FILE_SHA256) {
    throw new Error(`AMD file pin mismatch: ${amd.amendmentFileSha256}`);
  }
  if (amd.effectivePlanSha256 !== AMD_EFFECTIVE_PLAN_SHA256) {
    throw new Error(`AMD effective-plan pin mismatch: ${amd.effectivePlanSha256}`);
  }
}

export function fileIdentity(path: string): JsonObject {
  const stat = statSync(path);
  return { path: resolve(path), dev: stat.dev, ino: stat.ino, sha256: sha256(readFileSync(path)) };
}
