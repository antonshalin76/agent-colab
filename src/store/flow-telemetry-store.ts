import { isDeepStrictEqual } from "node:util";
import { dirname } from "node:path";
import type Database from "better-sqlite3";

import { assertGraphV4PersistenceSchema } from "../migration/graph-v4-schema.js";
import {
  createAgentEventEnvelope,
  deriveAttemptTerminalEventId,
  normalizeProviderUsage,
  sanitizeTelemetryProjection,
  verifyAgentEventEnvelope,
  type TelemetryPayload,
} from "../runtime/flow-telemetry.js";
import { dispatchTelemetryExport } from "../runtime/flow-telemetry-exporter.js";
import {
  assertNullableTelemetryStableId,
  assertProviderSessionIdentity,
  assertTelemetryEventType,
  assertTelemetryEventVersion,
  assertTelemetryProvider,
  assertTelemetrySessionKind,
  assertTelemetrySpanId,
  assertTelemetryStableId,
  assertTelemetryTraceId,
} from "../runtime/flow-telemetry-identity.js";
import {
  assertFlowTelemetryArchiveStoreAuthorityPort,
  type ArchiveCommitCapability,
  type ArchiveDeletionCapability,
  type FlowTelemetryArchiveStoreAuthorityPort,
} from "../app/flow-telemetry-archive-authority.js";
import { canonicalJson, computeBytesSha256, computeJsonSha256 } from "../domain/canonical-json.js";
import {
  openStateStoreAccess,
  type StateDatabaseAccess,
  type StateStoreInput,
} from "./state-database-fence.js";

type JsonObject = Record<string, unknown>;

interface SessionInput extends JsonObject {
  sessionId: string;
  flowId: string;
  attemptId: string | null;
  parentSessionId: string | null;
  kind: string;
  createdAt: number;
}

interface ProviderSessionRef extends JsonObject {
  schemaVersion: "ProviderSessionRef/v1";
  value: string;
  provenance: "command_pinned" | "provider_reported";
}

interface SessionTransitionInput extends JsonObject {
  flowId: string;
  sessionId: string;
  expectedStatus: "created" | "running" | "terminal" | "orphaned";
  status: "created" | "running" | "terminal" | "orphaned";
  providerSessionRef?: ProviderSessionRef;
  now: number;
}

interface EventInput extends JsonObject {
  eventId: string;
  flowId: string;
  nodeId: string | null;
  attemptId: string | null;
  sessionId: string | null;
  eventType: string;
  eventVersion: string;
  payload: JsonObject;
  parentSessionId: string | null;
  traceId: string | null;
  spanId: string | null;
  createdAt: number;
}

interface AgentEventEnvelope extends JsonObject {
  schemaVersion: "FlowEvent/v1";
  eventId: string;
  flowId: string;
  sequenceNo: number;
  nodeId: string | null;
  attemptId: string | null;
  sessionId: string | null;
  eventType: string;
  eventVersion: string;
  payloadSha256: string;
  previousEventSha256: string | null;
  parentSessionId: string | null;
  traceId: string | null;
  spanId: string | null;
  createdAt: number;
  eventSha256: string;
}

interface UsageInput extends JsonObject {
  flowId: string;
  nodeId: string;
  attemptId: string;
  sessionId: string;
  usageId: string;
  provider: string;
  providerSessionId: string;
  receiptId: string;
  scope: "self" | "subtree";
  coveredAttemptIds: string[];
  normalizedUsage: JsonObject;
  createdAt: number;
}

type UsageRelationInput = Pick<UsageInput,
  "flowId" | "nodeId" | "attemptId" | "sessionId" | "providerSessionId" |
  "scope" | "coveredAttemptIds" | "createdAt">;

interface TerminalInput extends JsonObject {
  flowId: string;
  nodeId: string;
  attemptId: string;
  sessionId: string;
  provider: string;
  attemptOrdinal: number;
  outcome: "succeeded" | "provider_failure" | "timeout" | "malformed_terminal";
  errorClassification: null | "provider_error" | "timeout" | "malformed_terminal";
  startedAt: number;
  terminalAt: number;
  usageObservation: {
    status: "exact" | "partial" | "unavailable" | "invalid_provider_usage";
    usageId: string | null;
  };
}

interface EventCommit {
  eventId: string;
  sequenceNo: number;
  eventSha256: string;
  replayed: boolean;
  event: AgentEventEnvelope;
}

export interface ArchiveMemberProjection {
  eventId: string;
  sequenceNo: number;
  eventSha256: string;
  payloadSha256: string;
  payloadJson?: string;
}

export interface FreshArchivePreparation {
  phase: "new";
  archiveId: string;
  flowId: string;
  requestId: string;
  requestSha256: string;
  relativePath: string;
  firstSequence: number;
  lastSequence: number;
  createdAt: number;
  expectedFlowUpdatedAt: number;
  replayed: false;
  members: readonly Required<ArchiveMemberProjection>[];
}

export interface ArchiveManifestProjection {
  archiveId: string;
  flowId: string;
  firstSequence: number;
  lastSequence: number;
  relativePath: string;
  archiveSha256: string;
  merkleRootSha256: string;
  memberCount: number;
  createdAt: number;
  members: readonly ArchiveMemberProjection[];
}

export interface CommittedArchivePreparation extends ArchiveManifestProjection {
  phase: "committed";
  requestId: string;
  requestSha256: null;
  replayed: true;
}

export type ArchivePreparation = FreshArchivePreparation | CommittedArchivePreparation;

export interface FlowTelemetryStoreOptions {
  faultInjector?: (point: string) => void;
  telemetryExporter?: (payload: Readonly<JsonObject>) => unknown | Promise<unknown>;
  telemetryExportTimeoutMs?: number;
}

interface SessionRow {
  session_id: string;
  flow_id: string;
  attempt_id: string | null;
  parent_session_id: string | null;
  provider_session_ref: string | null;
  kind: string;
  status: "created" | "running" | "terminal" | "orphaned";
  created_at: number;
  terminal_at: number | null;
}

interface AttemptRow {
  attempt_id: string;
  flow_id: string;
  node_id: string;
  attempt_no: number;
  session_id: string;
  status: string;
  created_at: number;
  terminal_at: number | null;
}

interface EventRow {
  event_id: string;
  flow_id: string;
  sequence_no: number;
  node_id: string | null;
  attempt_id: string | null;
  session_id: string | null;
  event_type: string;
  event_version: string;
  payload_sha256: string | null;
  previous_event_sha256: string | null;
  event_sha256: string;
  trace_id: string | null;
  span_id: string | null;
  created_at: number;
}

interface PayloadRow {
  event_id: string;
  payload_json: string;
  payload_sha256: string;
}

interface UsageRow {
  usage_id: string;
  flow_id: string;
  attempt_id: string;
  provider: string;
  provider_session_id: string;
  receipt_id: string;
  scope: "self" | "subtree";
  input_tokens: number | null;
  output_tokens: number | null;
  cost_microusd: number | null;
  completeness: "exact" | "partial" | "unavailable";
  receipt_sha256: string;
  created_at: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const RETENTION_MS = 90 * DAY_MS;
const GIB = 1_024n * 1_024n * 1_024n;
const SHA256 = /^[a-f0-9]{64}$/;
const USAGE_RECEIPT_KEYS = [
  "schemaVersion", "flowId", "usageId", "attemptId", "provider", "providerSessionId",
  "receiptId", "scope", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens",
  "totalTokens", "costUsd", "costMicroUsd", "completeness", "provenance", "coverageCount",
  "coverageSha256", "createdAt",
] as const;
const TERMINAL_RECEIPT_KEYS = [
  "schemaVersion", "flowId", "nodeId", "attemptId", "sessionId", "provider", "attemptOrdinal",
  "outcome", "errorClassification", "startedAt", "terminalAt", "usageObservation",
] as const;
const SPECIALIZED_EVENT_OWNER = new Map<string, "usage" | "terminal" | "archive">([
  ["attempt_usage_recorded", "usage"],
  ["attempt_terminal", "terminal"],
  ["archive_anchor", "archive"],
]);

const record = (value: unknown, label: string): JsonObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
};

const stringValue = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a nonempty string`);
  return value;
};

const safeTime = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a nonnegative safe integer`);
  return Number(value);
};

const positiveInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive safe integer`);
  return Number(value);
};

const assertExactKeys = (value: JsonObject, expected: readonly string[], label: string): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!isDeepStrictEqual(actual, wanted)) throw new Error(`${label} has invalid fields`);
};

const parseJson = (value: string, label: string): JsonObject => {
  try { return record(JSON.parse(value), label); }
  catch (error) { throw new Error(`${label} is not valid JSON`, { cause: error }); }
};

const parseProviderSessionRef = (value: unknown): ProviderSessionRef => {
  const candidate = record(value, "provider session reference");
  assertExactKeys(candidate, ["schemaVersion", "value", "provenance"], "provider session reference");
  if (candidate.schemaVersion !== "ProviderSessionRef/v1") throw new Error("provider session reference schema is invalid");
  const providerValue = assertProviderSessionIdentity(candidate.value, "provider session identity");
  if (candidate.provenance !== "command_pinned" && candidate.provenance !== "provider_reported") {
    throw new Error("provider session reference provenance is invalid");
  }
  return {
    schemaVersion: "ProviderSessionRef/v1",
    value: providerValue,
    provenance: candidate.provenance,
  };
};

const exactRow = (left: unknown, right: unknown, label: string): void => {
  if (!isDeepStrictEqual(left, right)) throw new Error(`${label} conflicts with immutable persisted state`);
};

const eventRowProjection = (event: AgentEventEnvelope): EventRow => ({
  event_id: event.eventId,
  flow_id: event.flowId,
  sequence_no: event.sequenceNo,
  node_id: event.nodeId,
  attempt_id: event.attemptId,
  session_id: event.sessionId,
  event_type: event.eventType,
  event_version: event.eventVersion,
  payload_sha256: event.payloadSha256,
  previous_event_sha256: event.previousEventSha256,
  event_sha256: event.eventSha256,
  trace_id: event.traceId,
  span_id: event.spanId,
  created_at: event.createdAt,
});

const payloadRowProjection = (eventId: string, payloadJson: string): PayloadRow => ({
  event_id: eventId,
  payload_json: payloadJson,
  payload_sha256: computeJsonSha256(JSON.parse(payloadJson)),
});

const eventEnvelopeFromRow = (row: EventRow, parentSessionId: string | null): AgentEventEnvelope => ({
  schemaVersion: "FlowEvent/v1",
  eventId: row.event_id,
  flowId: row.flow_id,
  sequenceNo: row.sequence_no,
  nodeId: row.node_id,
  attemptId: row.attempt_id,
  sessionId: row.session_id,
  eventType: row.event_type,
  eventVersion: row.event_version,
  payloadSha256: stringValue(row.payload_sha256, "event payload digest"),
  previousEventSha256: row.previous_event_sha256,
  parentSessionId,
  traceId: row.trace_id,
  spanId: row.span_id,
  createdAt: row.created_at,
  eventSha256: row.event_sha256,
});

const archiveIdentity = (flowId: string, requestId: string): { archiveId: string; relativePath: string } => {
  const archiveId = computeJsonSha256({ flowId, requestId });
  return {
    archiveId,
    relativePath: `telemetry-archives/${computeBytesSha256(flowId)}/${computeBytesSha256(archiveId)}.jsonl`,
  };
};

const archiveRelativePath = (flowId: string, archiveId: string): string =>
  `telemetry-archives/${computeBytesSha256(flowId)}/${computeBytesSha256(archiveId)}.jsonl`;

const exactTypedPayload = (payload: TelemetryPayload, label: string): TelemetryPayload & JsonObject => {
  const sanitized = sanitizeTelemetryProjection(payload, true) as unknown as TelemetryPayload;
  if (!isDeepStrictEqual(sanitized, payload)) {
    throw new Error(`${label} contains a sensitive value that would change its immutable projection`);
  }
  return sanitized as TelemetryPayload & JsonObject;
};

export class FlowTelemetryStore {
  private readonly access: StateDatabaseAccess;
  private readonly db: Database.Database;
  private readonly closeAccess: () => void;
  private archiveAuthority: FlowTelemetryArchiveStoreAuthorityPort | undefined;
  private closed = false;

  constructor(database: StateStoreInput, private readonly options: FlowTelemetryStoreOptions = {}) {
    const opened = openStateStoreAccess(database);
    this.access = opened.access;
    this.closeAccess = opened.close;
    this.db = this.access.database;
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      this.db.transaction(() => {
        assertGraphV4PersistenceSchema(this.db);
        this.verifyIntegrity();
      }).deferred();
    } catch (error) {
      this.closeAccess();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeAccess();
  }

  bindArchiveAuthority(authority: FlowTelemetryArchiveStoreAuthorityPort): void {
    this.assertOpen();
    assertFlowTelemetryArchiveStoreAuthorityPort(authority);
    if (this.archiveAuthority !== undefined && this.archiveAuthority !== authority) {
      throw new Error("telemetry store already has a different archive authority");
    }
    authority.bindStore(this, dirname(this.access.canonicalPath));
    this.archiveAuthority = authority;
  }

  createSession(input: unknown): { sessionId: string; replayed: boolean } {
    return this.immediate(() => this.createSessionCore(input));
  }

  createSessionInTransaction(
    access: StateDatabaseAccess,
    input: unknown,
  ): { sessionId: string; replayed: boolean } {
    this.assertTransactionAccess(access);
    return this.createSessionCore(input);
  }

  transitionSession(input: unknown): { sessionId: string; status: string; replayed: boolean } {
    return this.immediate(() => this.transitionSessionCore(input));
  }

  transitionSessionInTransaction(
    access: StateDatabaseAccess,
    input: unknown,
  ): { sessionId: string; status: string; replayed: boolean } {
    this.assertTransactionAccess(access);
    return this.transitionSessionCore(input);
  }

  appendEvent(input: unknown): { eventId: string; sequenceNo: number; eventSha256: string; replayed: boolean } {
    const committed = this.immediate(() => this.appendEventCore(input));
    this.exportCommittedEvent(committed);
    return this.publicEventCommit(committed);
  }

  appendEventInTransaction(
    access: StateDatabaseAccess,
    input: unknown,
  ): { eventId: string; sequenceNo: number; eventSha256: string; replayed: boolean } {
    this.assertTransactionAccess(access);
    return this.publicEventCommit(this.appendEventCore(input));
  }

  recordUsage(input: unknown): { usageId: string; eventId: string; replayed: boolean } {
    const committed = this.immediate(() => this.recordUsageCore(input));
    this.exportCommittedEvent(committed.event);
    return { usageId: committed.usageId, eventId: committed.event.eventId, replayed: committed.event.replayed };
  }

  recordUsageInTransaction(
    access: StateDatabaseAccess,
    input: unknown,
  ): { usageId: string; eventId: string; replayed: boolean } {
    this.assertTransactionAccess(access);
    const committed = this.recordUsageCore(input);
    return { usageId: committed.usageId, eventId: committed.event.eventId, replayed: committed.event.replayed };
  }

  recordAttemptTerminal(input: unknown): { eventId: string; replayed: boolean } {
    const committed = this.immediate(() => this.recordAttemptTerminalCore(input));
    this.exportCommittedEvent(committed.event);
    return { eventId: committed.event.eventId, replayed: committed.event.replayed };
  }

  recordAttemptTerminalInTransaction(
    access: StateDatabaseAccess,
    input: unknown,
  ): { eventId: string; replayed: boolean } {
    this.assertTransactionAccess(access);
    const committed = this.recordAttemptTerminalCore(input);
    return { eventId: committed.event.eventId, replayed: committed.event.replayed };
  }

  prepareArchive(input: unknown): ArchivePreparation {
    this.assertOpen();
    const candidate = record(input, "archive request");
    const flowId = assertTelemetryStableId(candidate.flowId, "flowId", "archive flow id");
    const requestId = assertTelemetryStableId(candidate.requestId, "requestId", "archive request id");
    const firstSequence = positiveInteger(candidate.firstSequence, "archive first sequence");
    const lastSequence = positiveInteger(candidate.lastSequence, "archive last sequence");
    if (lastSequence < firstSequence) throw new Error("archive range is invalid");
    const now = safeTime(candidate.now, "archive time");
    if (typeof candidate.databaseBytes !== "bigint" || candidate.databaseBytes < 0n) {
      throw new Error("archive databaseBytes must be a nonnegative bigint");
    }
    const identity = archiveIdentity(flowId, requestId);
    const existing = this.readArchiveManifest(identity.archiveId);
    if (existing) {
      if (existing.flowId !== flowId || existing.firstSequence !== firstSequence ||
          existing.lastSequence !== lastSequence || existing.relativePath !== identity.relativePath) {
        throw new Error("archive request identity conflicts with immutable range");
      }
      return { ...existing, phase: "committed", requestId, requestSha256: null, replayed: true };
    }

    const flow = this.db.prepare("SELECT status,updated_at FROM graph_flows WHERE flow_id=?")
      .get(flowId) as { status: string; updated_at: number } | undefined;
    if (!flow || !["succeeded", "failed", "cancelled"].includes(flow.status)) {
      throw new Error("flow is not terminal and archive eligible");
    }
    if (now < flow.updated_at) throw new Error("archive retention time is retrocausal");
    if (now - flow.updated_at < RETENTION_MS && candidate.databaseBytes < GIB) {
      throw new Error("flow does not meet archive retention or database size eligibility");
    }
    const overlap = this.db.prepare(`SELECT archive_id FROM agent_event_archives
      WHERE flow_id=? AND NOT(last_sequence<? OR first_sequence>?) LIMIT 1`)
      .pluck().get(flowId, firstSequence, lastSequence);
    if (overlap !== undefined) throw new Error("archive range overlaps an existing archive");
    const rows = this.db.prepare(`SELECT e.*,p.payload_json,p.payload_sha256 AS body_sha256
      FROM agent_events e LEFT JOIN agent_event_payloads p ON p.event_id=e.event_id
      WHERE e.flow_id=? AND e.sequence_no BETWEEN ? AND ? ORDER BY e.sequence_no`)
      .all(flowId, firstSequence, lastSequence) as Array<EventRow & {
        payload_json: string | null; body_sha256: string | null;
      }>;
    if (rows.length !== lastSequence - firstSequence + 1 || rows.some((row) => row.event_type === "archive_anchor")) {
      throw new Error("archive members must be one contiguous non-anchor range");
    }
    const members = rows.map((row): Required<ArchiveMemberProjection> => {
      if (row.payload_json === null || row.body_sha256 === null || row.payload_sha256 !== row.body_sha256) {
        throw new Error("archive range has a missing or invalid live payload");
      }
      return {
        eventId: row.event_id,
        sequenceNo: row.sequence_no,
        eventSha256: row.event_sha256,
        payloadSha256: row.body_sha256,
        payloadJson: row.payload_json,
      };
    });
    const canonicalMembers = members.map((member) => ({
      schemaVersion: "AgentEventArchiveMember/v1",
      flowId,
      ...member,
    }));
    const request = {
      schemaVersion: "AgentEventArchiveRequest/v1",
      requestId,
      flowId,
      firstSequence,
      lastSequence,
      membersSha256: computeJsonSha256(canonicalMembers),
    };
    const prepared: FreshArchivePreparation = {
      phase: "new",
      archiveId: identity.archiveId,
      flowId,
      requestId,
      requestSha256: computeJsonSha256(request),
      relativePath: identity.relativePath,
      firstSequence,
      lastSequence,
      createdAt: now,
      expectedFlowUpdatedAt: flow.updated_at,
      replayed: false,
      members,
    };
    return prepared;
  }

  commitArchiveManifest(input: {
    capability: ArchiveCommitCapability;
    prepared: FreshArchivePreparation;
    archive: {
      archiveId: string;
      flowId: string;
      requestSha256: string;
      relativePath: string;
      archiveSha256: string;
      merkleRootSha256: string;
      createdAt: number;
      firstSequence: number;
      lastSequence: number;
      members: readonly ArchiveMemberProjection[];
    };
  }): { replayed: boolean; deletionCapability: ArchiveDeletionCapability } {
    const authority = this.requireArchiveAuthority();
    const commit = { prepared: input.prepared, archive: input.archive };
    let claim: ReturnType<FlowTelemetryArchiveStoreAuthorityPort["claimCommitCapability"]> | undefined;
    try {
      this.options.faultInjector?.("before_archive_commit_transaction");
      const result = this.immediate(() => {
        claim = authority.claimCommitCapability({ store: this, capability: input.capability, commit });
        this.options.faultInjector?.("after_archive_commit_authority_claim");
        const committed = this.commitArchiveManifestCore(commit);
        this.options.faultInjector?.("after_archive_manifest_mutation_before_file_reverify");
        claim.assertCurrent();
        return committed;
      });
      const deletionCapability = claim!.complete();
      return { ...result, deletionCapability };
    } catch (error) {
      claim?.abort();
      throw error;
    }
  }

  deleteArchivedPayloads(input: {
    capability: ArchiveDeletionCapability;
    archiveId: string;
    flowId: string;
    archiveSha256: string;
    merkleRootSha256: string;
    members: readonly ArchiveMemberProjection[];
  }): { replayed: boolean } {
    const authority = this.requireArchiveAuthority();
    const { capability, ...deletion } = input;
    let claim: ReturnType<FlowTelemetryArchiveStoreAuthorityPort["claimDeletionCapability"]> | undefined;
    try {
      const result = this.immediate(() => {
        claim = authority.claimDeletionCapability({ store: this, capability, deletion });
        this.options.faultInjector?.("after_archive_deletion_authority_claim");
        const manifest = this.readArchiveManifest(input.archiveId);
        if (!manifest) throw new Error("archive manifest is missing");
        if (manifest.flowId !== input.flowId || manifest.archiveSha256 !== input.archiveSha256 ||
            manifest.merkleRootSha256 !== input.merkleRootSha256 ||
            !isDeepStrictEqual(manifest.members, input.members.map(({ payloadJson: _payload, ...member }) => member))) {
          throw new Error("archive deletion manifest conflicts with immutable state");
        }
        const present = input.members.map((member) => this.db.prepare(
          "SELECT payload_sha256 FROM agent_event_payloads WHERE event_id=?",
        ).pluck().get(member.eventId) as string | undefined);
        if (present.every((value) => value === undefined)) return { replayed: true };
        if (present.some((value) => value === undefined) || present.some((value, index) => value !== input.members[index]!.payloadSha256)) {
          throw new Error("archive payload deletion is mixed or has a digest mismatch");
        }
        const remove = this.db.prepare("DELETE FROM agent_event_payloads WHERE event_id=? AND payload_sha256=?");
        for (const member of input.members) {
          if (remove.run(member.eventId, member.payloadSha256).changes !== 1) {
            throw new Error("archive payload deletion lost its compare-and-swap");
          }
        }
        this.options.faultInjector?.("after_archive_payload_delete_before_file_reverify");
        claim.assertCurrent();
        return { replayed: false };
      });
      claim!.complete();
      return result;
    } catch (error) {
      claim?.abort();
      throw error;
    }
  }

  resolvePayload(input: { flowId: string; eventId: string }):
    | { kind: "live"; payloadJson: string; payloadSha256: string }
    | { kind: "archived"; manifest: ArchiveManifestProjection; targetEventId: string } {
    this.assertOpen();
    const archived = this.db.prepare(`SELECT m.archive_id FROM agent_event_archive_members m
      WHERE m.flow_id=? AND m.event_id=?`).pluck().get(input.flowId, input.eventId) as string | undefined;
    if (archived !== undefined) {
      const manifest = this.readArchiveManifest(archived);
      if (!manifest) throw new Error("archive membership has no manifest");
      return { kind: "archived", manifest, targetEventId: input.eventId };
    }
    const payload = this.db.prepare(`SELECT p.payload_json,p.payload_sha256 FROM agent_event_payloads p
      JOIN agent_events e ON e.event_id=p.event_id WHERE e.flow_id=? AND e.event_id=?`)
      .get(input.flowId, input.eventId) as { payload_json: string; payload_sha256: string } | undefined;
    if (!payload) throw new Error("telemetry payload is missing");
    return { kind: "live", payloadJson: payload.payload_json, payloadSha256: payload.payload_sha256 };
  }

  verifyResolvedPayload(input: {
    flowId: string;
    eventId: string;
    payloadJson: string;
    payloadSha256: string;
  }): void {
    this.assertOpen();
    const flowId = assertTelemetryStableId(input.flowId, "flowId", "resolved payload flow id");
    const eventId = assertTelemetryStableId(input.eventId, "eventId", "resolved payload event id");
    if (typeof input.payloadJson !== "string" || !SHA256.test(input.payloadSha256) ||
        computeBytesSha256(input.payloadJson) !== input.payloadSha256) {
      throw new Error("resolved telemetry payload bytes or digest are invalid");
    }
    const event = this.db.prepare("SELECT * FROM agent_events WHERE flow_id=? AND event_id=?")
      .get(flowId, eventId) as EventRow | undefined;
    if (!event || event.payload_sha256 !== input.payloadSha256) {
      throw new Error("resolved telemetry payload conflicts with its event projection");
    }
    const wrapper = parseJson(input.payloadJson, "resolved telemetry payload");
    if (canonicalJson(wrapper) !== input.payloadJson) {
      throw new Error("resolved telemetry payload is not canonical JSON");
    }
    const sanitized = sanitizeTelemetryProjection(wrapper, true);
    if (!isDeepStrictEqual(sanitized, wrapper)) {
      throw new Error("resolved telemetry payload contains a sensitive immutable value");
    }
    if (event.event_type === "attempt_usage_recorded") {
      const row = this.db.prepare("SELECT * FROM agent_attempt_usage WHERE usage_id=?")
        .get(event.event_id) as UsageRow | undefined;
      if (!row) throw new Error("resolved usage payload has no SQL projection");
      const coverage = this.db.prepare(`SELECT covered_attempt_id FROM agent_usage_coverage
        WHERE usage_id=? ORDER BY covered_attempt_id`).pluck().all(row.usage_id) as string[];
      this.verifyProjectedUsageRelations(row, event, coverage);
      this.verifyUsagePayloadProjection(row, event, input.payloadJson, input.payloadSha256, coverage);
    } else if (event.event_type === "attempt_terminal") {
      this.verifyTerminalEventIntegrity(event, input.payloadJson);
    }
  }

  getRunTelemetryLink(runId: string): JsonObject {
    this.assertOpen();
    const run = this.db.prepare("SELECT id FROM runs WHERE id=?").get(runId);
    if (!run) throw new Error("run does not exist");
    const attempt = this.db.prepare("SELECT flow_id,attempt_id FROM graph_node_attempts WHERE run_id=?")
      .get(runId) as { flow_id: string; attempt_id: string } | undefined;
    if (!attempt) return { status: "legacy_unlinked", usage: null, completeness: "unavailable" };
    const usage = this.db.prepare(`SELECT input_tokens,output_tokens,cost_microusd,completeness
      FROM agent_attempt_usage WHERE flow_id=? AND attempt_id=? ORDER BY created_at,usage_id`)
      .all(attempt.flow_id, attempt.attempt_id) as UsageRow[];
    return { status: "linked", flowId: attempt.flow_id, attemptId: attempt.attempt_id, usage };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("FlowTelemetryStore is closed");
    this.access.assertUsable();
  }

  private requireArchiveAuthority(): FlowTelemetryArchiveStoreAuthorityPort {
    this.assertOpen();
    if (this.archiveAuthority === undefined) {
      throw new Error("archive authority capability is required for destructive archive operations");
    }
    return this.archiveAuthority;
  }

  private immediate<T>(operation: () => T): T {
    this.assertOpen();
    return this.db.transaction(operation).immediate();
  }

  private assertTransactionAccess(access: StateDatabaseAccess): void {
    this.assertOpen();
    if (access !== this.access) throw new Error("transaction access capability was not issued for this store");
    access.assertUsable();
    if (!this.db.inTransaction) throw new Error("transaction-aware telemetry write requires an active transaction");
  }

  private createSessionCore(input: unknown): { sessionId: string; replayed: boolean } {
    const candidate = record(input, "agent session");
    assertExactKeys(candidate, ["sessionId", "flowId", "attemptId", "parentSessionId", "kind", "createdAt"], "agent session");
    const parsed: SessionInput = {
      ...candidate,
      sessionId: assertTelemetryStableId(candidate.sessionId, "sessionId", "session id"),
      flowId: assertTelemetryStableId(candidate.flowId, "flowId", "session flow id"),
      attemptId: assertNullableTelemetryStableId(candidate.attemptId, "attemptId", "session attempt id"),
      parentSessionId: assertNullableTelemetryStableId(
        candidate.parentSessionId,
        "parentSessionId",
        "parent session id",
      ),
      kind: assertTelemetrySessionKind(candidate.kind),
      createdAt: safeTime(candidate.createdAt, "session createdAt"),
    };
    const existing = this.db.prepare("SELECT * FROM agent_sessions WHERE session_id=?").get(parsed.sessionId) as SessionRow | undefined;
    if (existing) {
      exactRow({
        session_id: existing.session_id,
        flow_id: existing.flow_id,
        attempt_id: existing.attempt_id,
        parent_session_id: existing.parent_session_id,
        kind: existing.kind,
        created_at: existing.created_at,
      }, {
        session_id: parsed.sessionId,
        flow_id: parsed.flowId,
        attempt_id: parsed.attemptId,
        parent_session_id: parsed.parentSessionId,
        kind: parsed.kind,
        created_at: parsed.createdAt,
      }, "agent session replay");
      return { sessionId: parsed.sessionId, replayed: true };
    }
    const flow = this.db.prepare("SELECT flow_id FROM graph_flows WHERE flow_id=?").get(parsed.flowId);
    if (!flow) throw new Error("session references a missing flow");
    if (parsed.attemptId !== null) {
      const attempt = this.db.prepare(`SELECT attempt_id,flow_id,node_id,attempt_no,session_id,status,created_at,terminal_at
        FROM graph_node_attempts WHERE flow_id=? AND attempt_id=?`).get(parsed.flowId, parsed.attemptId) as AttemptRow | undefined;
      if (!attempt) throw new Error("session references a missing or cross-flow attempt");
      if ((parsed.kind === "node_attempt") !== (parsed.sessionId === attempt.session_id)) {
        throw new Error("node attempt kind and immutable session binding must agree");
      }
      if (parsed.createdAt < attempt.created_at) throw new Error("session timestamp precedes its attempt");
    } else if (parsed.kind === "node_attempt") {
      throw new Error("node attempt session requires an immutable attempt binding");
    }
    if (parsed.parentSessionId !== null) {
      const parent = this.db.prepare("SELECT * FROM agent_sessions WHERE session_id=?")
        .get(parsed.parentSessionId) as SessionRow | undefined;
      if (!parent || parent.flow_id !== parsed.flowId) throw new Error("session parent is missing or cross-flow");
      if (parsed.createdAt < parent.created_at) throw new Error("session ancestry is retrocausal");
      if (parent.session_id === parsed.sessionId) throw new Error("session ancestry cycle is forbidden");
    }
    this.db.prepare(`INSERT INTO agent_sessions
      (session_id,flow_id,attempt_id,parent_session_id,provider_session_ref,kind,status,created_at,terminal_at)
      VALUES (?,?,?,?,?,?,'created',?,NULL)`).run(
        parsed.sessionId,
        parsed.flowId,
        parsed.attemptId,
        parsed.parentSessionId,
        null,
        parsed.kind,
        parsed.createdAt,
      );
    return { sessionId: parsed.sessionId, replayed: false };
  }

  private transitionSessionCore(input: unknown): { sessionId: string; status: string; replayed: boolean } {
    const candidate = record(input, "session transition");
    const allowedKeys = ["flowId", "sessionId", "expectedStatus", "status", "providerSessionRef", "now"];
    if (Object.keys(candidate).some((key) => !allowedKeys.includes(key))) throw new Error("session transition has invalid fields");
    const flowId = assertTelemetryStableId(candidate.flowId, "flowId", "session transition flow id");
    const sessionId = assertTelemetryStableId(candidate.sessionId, "sessionId", "session transition id");
    const expectedStatus = stringValue(candidate.expectedStatus, "expected session status");
    const status = stringValue(candidate.status, "target session status");
    if (!["created", "running", "terminal", "orphaned"].includes(expectedStatus) ||
        !["created", "running", "terminal", "orphaned"].includes(status)) {
      throw new Error("session transition status is invalid");
    }
    const now = safeTime(candidate.now, "session transition time");
    const row = this.db.prepare("SELECT * FROM agent_sessions WHERE session_id=?").get(sessionId) as SessionRow | undefined;
    if (!row || row.flow_id !== flowId) throw new Error("session transition references a missing or cross-flow session");
    if (now < row.created_at) throw new Error("session transition time is retrocausal");
    const requestedRef = candidate.providerSessionRef === undefined ? undefined : parseProviderSessionRef(candidate.providerSessionRef);
    const existingRef = row.provider_session_ref === null ? null : parseProviderSessionRef(parseJson(row.provider_session_ref, "provider session reference"));
    if (row.status === status) {
      if (requestedRef !== undefined && !isDeepStrictEqual(requestedRef, existingRef)) {
        throw new Error("provider session reference is immutable and set once");
      }
      if (expectedStatus !== row.status) throw new Error("session transition compare-and-swap state mismatch");
      return { sessionId, status, replayed: true };
    }
    if (row.status !== expectedStatus) throw new Error("session transition compare-and-swap state mismatch");
    if (row.status === "created" && status === "running") {
      if (requestedRef === undefined) throw new Error("running session requires a provider session reference");
    } else if (row.status === "running" && (status === "terminal" || status === "orphaned")) {
      if (requestedRef !== undefined && !isDeepStrictEqual(requestedRef, existingRef)) {
        throw new Error("provider session reference is immutable and set once");
      }
    } else {
      throw new Error("illegal agent session state transition");
    }
    const providerRefJson = requestedRef === undefined
      ? row.provider_session_ref
      : canonicalJson(requestedRef);
    const terminalAt = status === "terminal" || status === "orphaned" ? now : null;
    const changed = this.db.prepare(`UPDATE agent_sessions SET status=?,provider_session_ref=?,terminal_at=?
      WHERE session_id=? AND flow_id=? AND status=?`).run(
        status,
        providerRefJson,
        terminalAt,
        sessionId,
        flowId,
        expectedStatus,
      );
    if (changed.changes !== 1) throw new Error("session transition compare-and-swap lost its race");
    this.options.faultInjector?.("after_session_update");
    return { sessionId, status, replayed: false };
  }

  private parseEventInput(input: unknown): EventInput {
    const candidate = record(input, "agent event");
    assertExactKeys(candidate, [
      "eventId", "flowId", "nodeId", "attemptId", "sessionId", "eventType", "eventVersion",
      "payload", "parentSessionId", "traceId", "spanId", "createdAt",
    ], "agent event");
    return {
      ...candidate,
      eventId: assertTelemetryStableId(candidate.eventId, "eventId", "event id"),
      flowId: assertTelemetryStableId(candidate.flowId, "flowId", "event flow id"),
      nodeId: assertNullableTelemetryStableId(candidate.nodeId, "nodeId", "event node id"),
      attemptId: assertNullableTelemetryStableId(candidate.attemptId, "attemptId", "event attempt id"),
      sessionId: assertNullableTelemetryStableId(candidate.sessionId, "sessionId", "event session id"),
      eventType: assertTelemetryEventType(candidate.eventType, "event type"),
      eventVersion: assertTelemetryEventVersion(candidate.eventVersion, "event version"),
      payload: record(candidate.payload, "event payload"),
      parentSessionId: assertNullableTelemetryStableId(
        candidate.parentSessionId,
        "parentSessionId",
        "event parent session id",
      ),
      traceId: candidate.traceId === null ? null : assertTelemetryTraceId(candidate.traceId, "event trace id"),
      spanId: candidate.spanId === null ? null : assertTelemetrySpanId(candidate.spanId, "event span id"),
      createdAt: safeTime(candidate.createdAt, "event createdAt"),
    };
  }

  private validateEventCausality(input: EventInput): void {
    if ((input.attemptId === null) !== (input.nodeId === null)) {
      throw new Error("event node and attempt causal identity disagree");
    }
    if (input.attemptId !== null && input.nodeId !== null) {
      const attempt = this.db.prepare(`SELECT attempt_id,flow_id,node_id,attempt_no,session_id,status,created_at,terminal_at
        FROM graph_node_attempts WHERE flow_id=? AND node_id=? AND attempt_id=?`)
        .get(input.flowId, input.nodeId, input.attemptId) as AttemptRow | undefined;
      if (!attempt) throw new Error("event references a missing, cross-flow, or wrong-node attempt");
      if (input.createdAt < attempt.created_at) throw new Error("event timestamp precedes attempt");
    }
    if (input.sessionId !== null) {
      const session = this.db.prepare("SELECT * FROM agent_sessions WHERE session_id=?").get(input.sessionId) as SessionRow | undefined;
      if (!session || session.flow_id !== input.flowId) throw new Error("event session is missing or cross-flow");
      if (session.attempt_id !== input.attemptId) throw new Error("event session and attempt causal identity disagree");
      if (session.parent_session_id !== input.parentSessionId) throw new Error("event parent differs from immutable session parent");
      if (input.createdAt < session.created_at) throw new Error("event timestamp precedes session");
    } else if (input.parentSessionId !== null) {
      throw new Error("event without a session cannot name a parent session");
    }
  }

  private appendEventCore(
    input: unknown,
    owner: "generic" | "usage" | "terminal" | "archive" = "generic",
  ): EventCommit {
    const parsed = this.parseEventInput(input);
    const requiredOwner = SPECIALIZED_EVENT_OWNER.get(parsed.eventType);
    if (requiredOwner !== undefined && requiredOwner !== owner) {
      throw new Error(`${parsed.eventType} is reserved for its typed persistence operation`);
    }
    this.validateEventCausality(parsed);
    const existing = this.db.prepare("SELECT * FROM agent_events WHERE event_id=?").get(parsed.eventId) as EventRow | undefined;
    if (existing) {
      const created = createAgentEventEnvelope({
        ...parsed,
        payload: parsed.payload as unknown as TelemetryPayload,
        sequenceNo: existing.sequence_no,
        previousEventSha256: existing.previous_event_sha256,
      }) as { event: AgentEventEnvelope; payloadJson: string };
      exactRow(existing, eventRowProjection(created.event), "agent event replay");
      const payload = this.db.prepare("SELECT * FROM agent_event_payloads WHERE event_id=?")
        .get(parsed.eventId) as PayloadRow | undefined;
      if (payload) exactRow(payload, payloadRowProjection(parsed.eventId, created.payloadJson), "agent event payload replay");
      else {
        const archived = this.db.prepare(`SELECT payload_sha256 FROM agent_event_archive_members
          WHERE flow_id=? AND event_id=?`).pluck().get(parsed.flowId, parsed.eventId);
        if (archived !== created.event.payloadSha256) throw new Error("archived event replay payload conflicts");
      }
      return { ...this.publicEventCommitData(created.event), replayed: true, event: created.event };
    }
    const previous = this.db.prepare("SELECT * FROM agent_events WHERE flow_id=? ORDER BY sequence_no DESC LIMIT 1")
      .get(parsed.flowId) as EventRow | undefined;
    const sequenceNo = previous ? previous.sequence_no + 1 : 1;
    const created = createAgentEventEnvelope({
      ...parsed,
      payload: parsed.payload as unknown as TelemetryPayload,
      sequenceNo,
      previousEventSha256: previous?.event_sha256 ?? null,
    }) as { event: AgentEventEnvelope; payloadJson: string };
    this.db.prepare(`INSERT INTO agent_events
      (event_id,flow_id,sequence_no,node_id,attempt_id,session_id,event_type,event_version,payload_sha256,
       previous_event_sha256,event_sha256,trace_id,span_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        created.event.eventId,
        created.event.flowId,
        created.event.sequenceNo,
        created.event.nodeId,
        created.event.attemptId,
        created.event.sessionId,
        created.event.eventType,
        created.event.eventVersion,
        created.event.payloadSha256,
        created.event.previousEventSha256,
        created.event.eventSha256,
        created.event.traceId,
        created.event.spanId,
        created.event.createdAt,
      );
    this.options.faultInjector?.("after_agent_event_insert");
    this.db.prepare(`INSERT INTO agent_event_payloads(event_id,payload_json,payload_sha256) VALUES (?,?,?)`)
      .run(created.event.eventId, created.payloadJson, created.event.payloadSha256);
    return { ...this.publicEventCommitData(created.event), replayed: false, event: created.event };
  }

  private publicEventCommitData(event: AgentEventEnvelope): Omit<EventCommit, "replayed" | "event"> {
    return {
      eventId: event.eventId,
      sequenceNo: event.sequenceNo,
      eventSha256: event.eventSha256,
    };
  }

  private publicEventCommit(commit: EventCommit): {
    eventId: string; sequenceNo: number; eventSha256: string; replayed: boolean;
  } {
    return {
      eventId: commit.eventId,
      sequenceNo: commit.sequenceNo,
      eventSha256: commit.eventSha256,
      replayed: commit.replayed,
    };
  }

  private recordUsageCore(input: unknown): { usageId: string; event: EventCommit } {
    const parsed = this.parseUsageInput(input);
    const receipt = this.usageReceipt(parsed);
    const parentSessionId = this.sessionParent(parsed.flowId, parsed.sessionId, parsed.attemptId);
    const payload = exactTypedPayload({
      schemaVersion: "TelemetryPayload/v1",
      parentSessionId,
      data: receipt,
    }, "usage receipt");
    const eventInput: EventInput = {
      eventId: parsed.usageId,
      flowId: parsed.flowId,
      nodeId: parsed.nodeId,
      attemptId: parsed.attemptId,
      sessionId: parsed.sessionId,
      eventType: "attempt_usage_recorded",
      eventVersion: "1",
      payload,
      parentSessionId,
      traceId: null,
      spanId: null,
      createdAt: parsed.createdAt,
    };
    const event = this.appendEventCore(eventInput, "usage");
    const expected: UsageRow = {
      usage_id: parsed.usageId,
      flow_id: parsed.flowId,
      attempt_id: parsed.attemptId,
      provider: parsed.provider,
      provider_session_id: parsed.providerSessionId,
      receipt_id: parsed.receiptId,
      scope: parsed.scope,
      input_tokens: parsed.normalizedUsage.inputTokens as number | null,
      output_tokens: parsed.normalizedUsage.outputTokens as number | null,
      cost_microusd: parsed.normalizedUsage.costMicroUsd as number | null,
      completeness: parsed.normalizedUsage.status as UsageRow["completeness"],
      receipt_sha256: event.event.payloadSha256,
      created_at: parsed.createdAt,
    };
    const existing = this.db.prepare("SELECT * FROM agent_attempt_usage WHERE usage_id=?")
      .get(parsed.usageId) as UsageRow | undefined;
    if (existing) {
      exactRow(existing, expected, "usage receipt replay");
      this.assertCoverageRows(parsed.flowId, parsed.usageId, parsed.coveredAttemptIds);
      if (!event.replayed) throw new Error("usage projection exists without its immutable event replay");
      return { usageId: parsed.usageId, event };
    }
    const natural = this.db.prepare(`SELECT usage_id FROM agent_attempt_usage
      WHERE provider=? AND provider_session_id=? AND attempt_id=? AND receipt_id=?`)
      .pluck().get(parsed.provider, parsed.providerSessionId, parsed.attemptId, parsed.receiptId);
    if (natural !== undefined) throw new Error("natural provider receipt identity conflicts with another usage id");
    this.db.prepare(`INSERT INTO agent_attempt_usage
      (usage_id,flow_id,attempt_id,provider,provider_session_id,receipt_id,scope,input_tokens,
       output_tokens,cost_microusd,completeness,receipt_sha256,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        expected.usage_id,
        expected.flow_id,
        expected.attempt_id,
        expected.provider,
        expected.provider_session_id,
        expected.receipt_id,
        expected.scope,
        expected.input_tokens,
        expected.output_tokens,
        expected.cost_microusd,
        expected.completeness,
        expected.receipt_sha256,
        expected.created_at,
      );
    this.options.faultInjector?.("after_usage_row_insert");
    const insertCoverage = this.db.prepare(`INSERT INTO agent_usage_coverage
      (flow_id,usage_id,covered_attempt_id) VALUES (?,?,?)`);
    for (const attemptId of parsed.coveredAttemptIds) insertCoverage.run(parsed.flowId, parsed.usageId, attemptId);
    return { usageId: parsed.usageId, event };
  }

  private parseUsageInput(input: unknown): UsageInput {
    const candidate = record(input, "usage receipt");
    assertExactKeys(candidate, [
      "flowId", "nodeId", "attemptId", "sessionId", "usageId", "provider", "providerSessionId",
      "receiptId", "scope", "coveredAttemptIds", "normalizedUsage", "createdAt",
    ], "usage receipt");
    const covered = candidate.coveredAttemptIds;
    if (!Array.isArray(covered)) {
      throw new Error("usage coverage must contain attempt ids");
    }
    const coveredAttemptIds = covered.map((item) =>
      assertTelemetryStableId(item, "attemptId", "usage covered attempt id"));
    const parsed: UsageInput = {
      ...candidate,
      flowId: assertTelemetryStableId(candidate.flowId, "flowId", "usage flow id"),
      nodeId: assertTelemetryStableId(candidate.nodeId, "nodeId", "usage node id"),
      attemptId: assertTelemetryStableId(candidate.attemptId, "attemptId", "usage attempt id"),
      sessionId: assertTelemetryStableId(candidate.sessionId, "sessionId", "usage session id"),
      usageId: assertTelemetryStableId(candidate.usageId, "usageId", "usage id"),
      provider: assertTelemetryProvider(candidate.provider, "usage provider"),
      providerSessionId: assertProviderSessionIdentity(candidate.providerSessionId, "usage provider session id"),
      receiptId: assertTelemetryStableId(candidate.receiptId, "receiptId", "usage provider receipt id"),
      scope: candidate.scope === "self" || candidate.scope === "subtree"
        ? candidate.scope : (() => { throw new Error("usage scope is invalid"); })(),
      coveredAttemptIds,
      normalizedUsage: record(candidate.normalizedUsage, "normalized usage"),
      createdAt: safeTime(candidate.createdAt, "usage createdAt"),
    };
    this.validateNormalizedUsage(parsed.provider, parsed.normalizedUsage);
    this.validateUsageIdentityAndCoverage(parsed);
    return parsed;
  }

  private validateNormalizedUsage(provider: string, usage: JsonObject): void {
    assertExactKeys(usage, [
      "status", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens",
      "costUsd", "costMicroUsd", "provenance",
    ], "normalized usage");
    if (usage.status === "invalid_provider_usage") throw new Error("invalid provider usage cannot be persisted");
    const normalized = normalizeProviderUsage({
      provider,
      usage: {
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        totalTokens: usage.totalTokens,
        costUsd: usage.costUsd,
      },
    }) as unknown as JsonObject;
    if (!isDeepStrictEqual(normalized, usage)) {
      throw new Error("normalized usage provenance or values conflict with canonical normalization");
    }
  }

  private validateUsageIdentityAndCoverage(input: UsageRelationInput): void {
    const attempt = this.db.prepare(`SELECT attempt_id,flow_id,node_id,attempt_no,session_id,status,created_at,terminal_at
      FROM graph_node_attempts WHERE flow_id=? AND node_id=? AND attempt_id=?`)
      .get(input.flowId, input.nodeId, input.attemptId) as AttemptRow | undefined;
    if (!attempt) throw new Error("usage references a missing or cross-flow graph attempt");
    const session = this.db.prepare("SELECT * FROM agent_sessions WHERE session_id=?").get(input.sessionId) as SessionRow | undefined;
    if (!session || session.flow_id !== input.flowId || session.attempt_id !== input.attemptId) {
      throw new Error("usage session does not match its attempt");
    }
    const providerRef = session.provider_session_ref === null
      ? null : parseProviderSessionRef(parseJson(session.provider_session_ref, "provider session reference"));
    if (!providerRef || providerRef.value !== input.providerSessionId) {
      throw new Error("usage provider session identity integrity does not match the agent session");
    }
    if (input.createdAt < session.created_at) throw new Error("usage timestamp is retrocausal");
    if (new Set(input.coveredAttemptIds).size !== input.coveredAttemptIds.length ||
        [...input.coveredAttemptIds].sort().some((value, index) => value !== input.coveredAttemptIds[index])) {
      throw new Error("usage coverage must be sorted and unique");
    }
    if (input.scope === "self" && input.coveredAttemptIds.length !== 0) {
      throw new Error("self usage cannot contain subtree coverage");
    }
    if (input.scope === "subtree" && input.coveredAttemptIds.length === 0) {
      throw new Error("subtree usage requires descendant coverage");
    }
    for (const coveredAttemptId of input.coveredAttemptIds) {
      if (coveredAttemptId === input.attemptId) {
        throw new Error("subtree usage coverage cannot contain its owner attempt");
      }
      const covered = this.db.prepare("SELECT flow_id,node_id FROM graph_node_attempts WHERE attempt_id=?")
        .get(coveredAttemptId) as { flow_id: string; node_id: string } | undefined;
      if (!covered || covered.flow_id !== input.flowId || !this.isDescendant(input.flowId, input.nodeId, covered.node_id)) {
        throw new Error("usage coverage must contain only same-flow descendants");
      }
    }
  }

  private isDescendant(flowId: string, sourceNodeId: string, targetNodeId: string): boolean {
    const found = this.db.prepare(`WITH RECURSIVE descendants(node_id) AS (
      SELECT target_id FROM graph_edges WHERE flow_id=? AND source_id=?
      UNION
      SELECT e.target_id FROM graph_edges e JOIN descendants d ON e.source_id=d.node_id WHERE e.flow_id=?
    ) SELECT 1 FROM descendants WHERE node_id=? LIMIT 1`).get(flowId, sourceNodeId, flowId, targetNodeId);
    return found !== undefined;
  }

  private usageReceipt(input: UsageInput): JsonObject {
    const usage = input.normalizedUsage;
    return {
      schemaVersion: "UsageReceipt/v1",
      flowId: input.flowId,
      usageId: input.usageId,
      attemptId: input.attemptId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      receiptId: input.receiptId,
      scope: input.scope,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
      costUsd: usage.costUsd,
      costMicroUsd: usage.costMicroUsd,
      completeness: usage.status,
      provenance: usage.provenance,
      coverageCount: input.coveredAttemptIds.length,
      coverageSha256: computeJsonSha256(input.coveredAttemptIds),
      createdAt: input.createdAt,
    };
  }

  private sessionParent(flowId: string, sessionId: string, attemptId: string): string | null {
    const session = this.db.prepare("SELECT * FROM agent_sessions WHERE session_id=?").get(sessionId) as SessionRow | undefined;
    if (!session || session.flow_id !== flowId || session.attempt_id !== attemptId) {
      throw new Error("session does not match flow and attempt");
    }
    return session.parent_session_id;
  }

  private recordAttemptTerminalCore(input: unknown): { event: EventCommit } {
    const parsed = this.parseTerminalInput(input);
    const session = this.validateTerminalRelations(parsed);
    const eventId = deriveAttemptTerminalEventId({
      flowId: parsed.flowId,
      attemptId: parsed.attemptId,
      eventVersion: "1",
    });
    const parentSessionId = session.parent_session_id;
    const payload = exactTypedPayload({
      schemaVersion: "TelemetryPayload/v1",
      parentSessionId,
      data: {
        schemaVersion: "AttemptTerminalReceipt/v1",
        flowId: parsed.flowId,
        nodeId: parsed.nodeId,
        attemptId: parsed.attemptId,
        sessionId: parsed.sessionId,
        provider: parsed.provider,
        attemptOrdinal: parsed.attemptOrdinal,
        outcome: parsed.outcome,
        errorClassification: parsed.errorClassification,
        startedAt: parsed.startedAt,
        terminalAt: parsed.terminalAt,
        usageObservation: parsed.usageObservation,
      },
    }, "terminal receipt");
    const event = this.appendEventCore({
      eventId,
      flowId: parsed.flowId,
      nodeId: parsed.nodeId,
      attemptId: parsed.attemptId,
      sessionId: parsed.sessionId,
      eventType: "attempt_terminal",
      eventVersion: "1",
      payload,
      parentSessionId,
      traceId: null,
      spanId: null,
      createdAt: parsed.terminalAt,
    }, "terminal");
    if (event.replayed) {
      if (session.status !== "terminal" || session.terminal_at !== parsed.terminalAt) {
        throw new Error("terminal receipt replay conflicts with session state");
      }
      return { event };
    }
    if (session.status !== "running") throw new Error("terminal receipt requires one running session");
    const changed = this.db.prepare(`UPDATE agent_sessions SET status='terminal',terminal_at=?
      WHERE session_id=? AND flow_id=? AND status='running'`).run(parsed.terminalAt, parsed.sessionId, parsed.flowId);
    if (changed.changes !== 1) throw new Error("terminal session compare-and-swap lost its race");
    return { event };
  }

  private validateTerminalRelations(parsed: TerminalInput): SessionRow {
    const attempt = this.db.prepare(`SELECT attempt_id,flow_id,node_id,attempt_no,session_id,status,created_at,terminal_at
      FROM graph_node_attempts WHERE attempt_id=?`).get(parsed.attemptId) as AttemptRow | undefined;
    if (!attempt || attempt.flow_id !== parsed.flowId || attempt.node_id !== parsed.nodeId ||
        attempt.session_id !== parsed.sessionId || attempt.attempt_no !== parsed.attemptOrdinal) {
      throw new Error("terminal receipt graph attempt identity or ordinal mismatch");
    }
    if (attempt.status === "running" || attempt.terminal_at === null) throw new Error("graph attempt is not terminal");
    if (attempt.created_at !== parsed.startedAt || attempt.terminal_at !== parsed.terminalAt) {
      throw new Error("terminal receipt attempt timestamps mismatch");
    }
    const expectedGraphStatus = parsed.outcome === "succeeded" ? "succeeded" : "failed";
    if (attempt.status !== expectedGraphStatus) throw new Error("terminal outcome does not match graph attempt status");
    this.validateTerminalUsage(parsed);
    const session = this.db.prepare("SELECT * FROM agent_sessions WHERE session_id=?").get(parsed.sessionId) as SessionRow | undefined;
    if (!session || session.flow_id !== parsed.flowId || session.attempt_id !== parsed.attemptId) {
      throw new Error("terminal receipt session identity mismatch");
    }
    return session;
  }

  private parseTerminalInput(input: unknown): TerminalInput {
    const candidate = record(input, "terminal receipt");
    assertExactKeys(candidate, [
      "flowId", "nodeId", "attemptId", "sessionId", "provider", "attemptOrdinal", "outcome",
      "errorClassification", "startedAt", "terminalAt", "usageObservation",
    ], "terminal receipt");
    const outcome = candidate.outcome;
    if (!["succeeded", "provider_failure", "timeout", "malformed_terminal"].includes(String(outcome))) {
      throw new Error("terminal receipt outcome is invalid");
    }
    const expectedClassification = outcome === "succeeded" ? null
      : outcome === "provider_failure" ? "provider_error"
      : outcome;
    if (candidate.errorClassification !== expectedClassification) {
      throw new Error("terminal outcome and error classification mismatch");
    }
    const usage = record(candidate.usageObservation, "terminal usage observation");
    assertExactKeys(usage, ["status", "usageId"], "terminal usage observation");
    if (!["exact", "partial", "unavailable", "invalid_provider_usage"].includes(String(usage.status))) {
      throw new Error("terminal usage observation status is invalid");
    }
    const usageId = usage.usageId === null
      ? null
      : assertTelemetryStableId(usage.usageId, "usageId", "terminal usage id");
    if ((usage.status === "exact" || usage.status === "partial") && usageId === null) {
      throw new Error("exact or partial terminal usage requires a receipt id");
    }
    if (usage.status === "invalid_provider_usage" && usageId !== null) {
      throw new Error("invalid provider usage cannot reference a receipt row");
    }
    return {
      ...candidate,
      flowId: assertTelemetryStableId(candidate.flowId, "flowId", "terminal flow id"),
      nodeId: assertTelemetryStableId(candidate.nodeId, "nodeId", "terminal node id"),
      attemptId: assertTelemetryStableId(candidate.attemptId, "attemptId", "terminal attempt id"),
      sessionId: assertTelemetryStableId(candidate.sessionId, "sessionId", "terminal session id"),
      provider: assertTelemetryProvider(candidate.provider, "terminal provider"),
      attemptOrdinal: positiveInteger(candidate.attemptOrdinal, "terminal attempt ordinal"),
      outcome: outcome as TerminalInput["outcome"],
      errorClassification: candidate.errorClassification as TerminalInput["errorClassification"],
      startedAt: safeTime(candidate.startedAt, "terminal startedAt"),
      terminalAt: safeTime(candidate.terminalAt, "terminal terminalAt"),
      usageObservation: { status: usage.status as TerminalInput["usageObservation"]["status"], usageId },
    };
  }

  private validateTerminalUsage(input: TerminalInput): void {
    const { status, usageId } = input.usageObservation;
    if (usageId === null) {
      if (status === "exact" || status === "partial") throw new Error("terminal usage receipt is missing");
      if (status === "unavailable" && input.outcome === "succeeded") {
        throw new Error("successful terminal requires an explicit usage receipt, including unavailable usage");
      }
      const receiptCount = this.db.prepare(`SELECT COUNT(*) FROM agent_attempt_usage
        WHERE flow_id=? AND attempt_id=?`).pluck().get(input.flowId, input.attemptId) as number;
      if (receiptCount !== 0) {
        throw new Error("terminal no-receipt usage status conflicts with persisted usage rows");
      }
      return;
    }
    const row = this.db.prepare("SELECT * FROM agent_attempt_usage WHERE usage_id=?").get(usageId) as UsageRow | undefined;
    if (!row || row.flow_id !== input.flowId || row.attempt_id !== input.attemptId || row.provider !== input.provider ||
        row.completeness !== status) {
      throw new Error("terminal usage receipt identity or completeness mismatch");
    }
    const session = this.db.prepare("SELECT provider_session_ref FROM agent_sessions WHERE session_id=?")
      .pluck().get(input.sessionId) as string | null | undefined;
    if (!session || parseProviderSessionRef(parseJson(session, "provider session reference")).value !== row.provider_session_id) {
      throw new Error("terminal usage provider session mismatch");
    }
  }

  private assertCoverageRows(flowId: string, usageId: string, coveredAttemptIds: readonly string[]): void {
    const actual = this.db.prepare(`SELECT flow_id,usage_id,covered_attempt_id FROM agent_usage_coverage
      WHERE usage_id=? ORDER BY covered_attempt_id`).all(usageId);
    const expected = coveredAttemptIds.map((attemptId) => ({
      flow_id: flowId,
      usage_id: usageId,
      covered_attempt_id: attemptId,
    }));
    exactRow(actual, expected, "usage coverage replay");
  }

  private commitArchiveManifestCore(input: {
    prepared: FreshArchivePreparation;
    archive: {
      archiveId: string;
      flowId: string;
      requestSha256: string;
      relativePath: string;
      archiveSha256: string;
      merkleRootSha256: string;
      createdAt: number;
      firstSequence: number;
      lastSequence: number;
      members: readonly ArchiveMemberProjection[];
    };
  }): { replayed: boolean } {
    const { prepared, archive } = input;
    const flowId = assertTelemetryStableId(prepared.flowId, "flowId", "archive preparation flow id");
    const requestId = assertTelemetryStableId(
      prepared.requestId,
      "requestId",
      "archive preparation request id",
    );
    const firstSequence = positiveInteger(prepared.firstSequence, "archive preparation first sequence");
    const lastSequence = positiveInteger(prepared.lastSequence, "archive preparation last sequence");
    safeTime(prepared.createdAt, "archive preparation createdAt");
    safeTime(prepared.expectedFlowUpdatedAt, "archive preparation expected flow updatedAt");
    const identity = archiveIdentity(flowId, requestId);
    if (lastSequence < firstSequence || !Array.isArray(prepared.members) ||
        prepared.members.length !== lastSequence - firstSequence + 1 ||
        prepared.archiveId !== identity.archiveId || prepared.relativePath !== identity.relativePath) {
      throw new Error("archive preparation identity, range, or path integrity failure");
    }
    const seenEventIds = new Set<string>();
    for (let index = 0; index < prepared.members.length; index += 1) {
      const member = prepared.members[index]!;
      const eventId = assertTelemetryStableId(member.eventId, "eventId", "archive member event id");
      if (seenEventIds.has(eventId) || member.sequenceNo !== firstSequence + index ||
          !SHA256.test(member.eventSha256) || !SHA256.test(member.payloadSha256) ||
          typeof member.payloadJson !== "string") {
        throw new Error("archive preparation member integrity failure");
      }
      seenEventIds.add(eventId);
      const payload = parseJson(member.payloadJson, "archive preparation member payload");
      if (canonicalJson(payload) !== member.payloadJson ||
          computeBytesSha256(member.payloadJson) !== member.payloadSha256) {
        throw new Error("archive preparation member payload integrity failure");
      }
    }
    const canonicalMembers = prepared.members.map((member) => ({
      schemaVersion: "AgentEventArchiveMember/v1",
      flowId,
      ...member,
    }));
    const expectedRequestSha256 = computeJsonSha256({
      schemaVersion: "AgentEventArchiveRequest/v1",
      requestId,
      flowId,
      firstSequence,
      lastSequence,
      membersSha256: computeJsonSha256(canonicalMembers),
    });
    if (prepared.requestSha256 !== expectedRequestSha256 || !SHA256.test(archive.archiveSha256) ||
        !SHA256.test(archive.merkleRootSha256)) {
      throw new Error("archive preparation request or digest integrity failure");
    }
    if (prepared.phase !== "new" || archive.archiveId !== prepared.archiveId || archive.flowId !== prepared.flowId ||
        archive.requestSha256 !== prepared.requestSha256 || archive.relativePath !== prepared.relativePath ||
        archive.createdAt !== prepared.createdAt || archive.firstSequence !== prepared.firstSequence ||
        archive.lastSequence !== prepared.lastSequence || !isDeepStrictEqual(archive.members, prepared.members)) {
      throw new Error("verified archive conflicts with its preparation");
    }
    const existing = this.readArchiveManifest(prepared.archiveId);
    if (existing) {
      if (existing.archiveSha256 !== archive.archiveSha256 ||
          existing.merkleRootSha256 !== archive.merkleRootSha256 ||
          !isDeepStrictEqual(existing.members, archive.members.map(({ payloadJson: _payload, ...member }) => member))) {
        throw new Error("archive manifest replay conflicts with immutable state");
      }
      return { replayed: true };
    }
    const flow = this.db.prepare("SELECT status,updated_at FROM graph_flows WHERE flow_id=?")
      .get(prepared.flowId) as { status: string; updated_at: number } | undefined;
    if (!flow || !["succeeded", "failed", "cancelled"].includes(flow.status) ||
        flow.updated_at !== prepared.expectedFlowUpdatedAt) {
      throw new Error("archive terminal updated_at compare-and-swap is stale");
    }
    const overlap = this.db.prepare(`SELECT archive_id FROM agent_event_archives
      WHERE flow_id=? AND NOT(last_sequence<? OR first_sequence>?) LIMIT 1`)
      .pluck().get(prepared.flowId, prepared.firstSequence, prepared.lastSequence);
    if (overlap !== undefined) throw new Error("archive manifest range overlaps existing state");
    for (const member of prepared.members) {
      const row = this.db.prepare(`SELECT e.event_sha256,e.payload_sha256,p.payload_json,p.payload_sha256 AS body_sha256
        FROM agent_events e JOIN agent_event_payloads p ON p.event_id=e.event_id
        WHERE e.flow_id=? AND e.event_id=? AND e.sequence_no=? AND e.event_type<>'archive_anchor'`)
        .get(prepared.flowId, member.eventId, member.sequenceNo) as {
          event_sha256: string; payload_sha256: string; payload_json: string; body_sha256: string;
        } | undefined;
      if (!row || row.event_sha256 !== member.eventSha256 || row.payload_sha256 !== member.payloadSha256 ||
          row.body_sha256 !== member.payloadSha256 || row.payload_json !== member.payloadJson) {
        throw new Error("archive member changed after preparation");
      }
    }
    this.db.prepare(`INSERT INTO agent_event_archives
      (archive_id,flow_id,first_sequence,last_sequence,archive_path,archive_sha256,merkle_root_sha256,member_count,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
        archive.archiveId,
        archive.flowId,
        archive.firstSequence,
        archive.lastSequence,
        archive.relativePath,
        archive.archiveSha256,
        archive.merkleRootSha256,
        archive.members.length,
        archive.createdAt,
      );
    const insertMember = this.db.prepare(`INSERT INTO agent_event_archive_members
      (flow_id,archive_id,event_id,payload_sha256) VALUES (?,?,?,?)`);
    for (const member of archive.members) {
      insertMember.run(archive.flowId, archive.archiveId, member.eventId, member.payloadSha256);
    }
    const anchorEventId = computeJsonSha256({ archiveId: archive.archiveId, eventVersion: "1" });
    this.appendEventCore({
      eventId: anchorEventId,
      flowId: archive.flowId,
      nodeId: null,
      attemptId: null,
      sessionId: null,
      eventType: "archive_anchor",
      eventVersion: "1",
      payload: {
        schemaVersion: "TelemetryPayload/v1",
        parentSessionId: null,
        data: {
          schemaVersion: "AgentEventArchiveAnchor/v1",
          archiveId: archive.archiveId,
          archiveSha256: archive.archiveSha256,
          merkleRootSha256: archive.merkleRootSha256,
          firstSequence: archive.firstSequence,
          lastSequence: archive.lastSequence,
          memberCount: archive.members.length,
        },
      },
      parentSessionId: null,
      traceId: null,
      spanId: null,
      createdAt: archive.createdAt,
    }, "archive");
    return { replayed: false };
  }

  private readArchiveManifest(archiveId: string): ArchiveManifestProjection | undefined {
    const row = this.db.prepare("SELECT * FROM agent_event_archives WHERE archive_id=?").get(archiveId) as {
      archive_id: string; flow_id: string; first_sequence: number; last_sequence: number; archive_path: string;
      archive_sha256: string; merkle_root_sha256: string; member_count: number; created_at: number;
    } | undefined;
    if (!row) return undefined;
    const members = this.db.prepare(`SELECT m.event_id,e.sequence_no,e.event_sha256,m.payload_sha256
      FROM agent_event_archive_members m JOIN agent_events e ON e.event_id=m.event_id AND e.flow_id=m.flow_id
      WHERE m.archive_id=? ORDER BY e.sequence_no`).all(archiveId) as Array<{
        event_id: string; sequence_no: number; event_sha256: string; payload_sha256: string;
      }>;
    if (members.length !== row.member_count) throw new Error("archive manifest member count integrity failure");
    return {
      archiveId: row.archive_id,
      flowId: row.flow_id,
      firstSequence: row.first_sequence,
      lastSequence: row.last_sequence,
      relativePath: row.archive_path,
      archiveSha256: row.archive_sha256,
      merkleRootSha256: row.merkle_root_sha256,
      memberCount: row.member_count,
      createdAt: row.created_at,
      members: members.map((member) => ({
        eventId: member.event_id,
        sequenceNo: member.sequence_no,
        eventSha256: member.event_sha256,
        payloadSha256: member.payload_sha256,
      })),
    };
  }

  private exportCommittedEvent(commit: EventCommit): void {
    if (commit.replayed || !this.options.telemetryExporter) return;
    try {
      dispatchTelemetryExport({
        exporter: this.options.telemetryExporter,
        timeoutMs: this.options.telemetryExportTimeoutMs ?? 1_000,
        payload: {
          schemaVersion: "TelemetryExport/v1",
          flowId: commit.event.flowId,
          eventId: commit.event.eventId,
          sequenceNo: commit.event.sequenceNo,
          eventType: commit.event.eventType,
          eventVersion: commit.event.eventVersion,
          eventSha256: commit.event.eventSha256,
          createdAt: commit.event.createdAt,
        },
      });
    } catch {
      // Export is deliberately best-effort and can never turn a durable commit into an API failure.
    }
  }

  private verifyIntegrity(): void {
    if ((this.db.pragma("foreign_key_check") as unknown[]).length !== 0) {
      throw new Error("telemetry persistence foreign-key integrity failure");
    }
    const events = this.db.prepare("SELECT * FROM agent_events ORDER BY flow_id,sequence_no").all() as EventRow[];
    const previousByFlow = new Map<string, AgentEventEnvelope>();
    for (const row of events) {
      const payload = this.db.prepare("SELECT * FROM agent_event_payloads WHERE event_id=?").get(row.event_id) as PayloadRow | undefined;
      const sessionParent = row.session_id === null ? null : (this.db.prepare(
        "SELECT parent_session_id FROM agent_sessions WHERE flow_id=? AND session_id=?",
      ).pluck().get(row.flow_id, row.session_id) as string | null | undefined);
      if (row.session_id !== null && sessionParent === undefined) throw new Error("event integrity has a missing session");
      const parentSessionId = sessionParent ?? null;
      if (payload) {
        const wrapper = parseJson(payload.payload_json, "telemetry payload wrapper");
        if (wrapper.parentSessionId !== null && typeof wrapper.parentSessionId !== "string") {
          throw new Error("telemetry payload parentSessionId is invalid");
        }
        if (wrapper.parentSessionId !== parentSessionId) {
          throw new Error("telemetry payload parent integrity conflicts with immutable session ancestry");
        }
        if (payload.payload_sha256 !== row.payload_sha256 || computeJsonSha256(JSON.parse(payload.payload_json)) !== payload.payload_sha256) {
          throw new Error("telemetry payload digest integrity failure");
        }
      } else {
        const archived = this.db.prepare(`SELECT payload_sha256 FROM agent_event_archive_members
          WHERE flow_id=? AND event_id=?`).all(row.flow_id, row.event_id) as Array<{ payload_sha256: string }>;
        if (archived.length !== 1 || archived[0]!.payload_sha256 !== row.payload_sha256) {
          throw new Error("event payload is missing without one valid archive member");
        }
      }
      const event = eventEnvelopeFromRow(row, parentSessionId);
      const previous = previousByFlow.get(row.flow_id);
      if (payload) verifyAgentEventEnvelope(event, payload.payload_json, previous);
      else {
        const { eventSha256, ...unsigned } = event;
        if (computeJsonSha256(unsigned) !== eventSha256 ||
            event.previousEventSha256 !== (previous?.eventSha256 ?? null) ||
            event.sequenceNo !== (previous ? previous.sequenceNo + 1 : 1)) {
          throw new Error("archived event hash chain integrity failure");
        }
      }
      this.verifyTerminalEventIntegrity(row, payload?.payload_json);
      previousByFlow.set(row.flow_id, event);
    }
    const payloadCount = this.db.prepare("SELECT COUNT(*) FROM agent_event_payloads").pluck().get() as number;
    const payloadJoined = this.db.prepare(`SELECT COUNT(*) FROM agent_event_payloads p
      JOIN agent_events e ON e.event_id=p.event_id`).pluck().get() as number;
    if (payloadCount !== payloadJoined) throw new Error("orphan telemetry payload integrity failure");
    this.verifySessionIntegrity();
    this.verifyUsageIntegrity();
    this.verifyArchiveIntegrity();
  }

  private verifySessionIntegrity(): void {
    const rows = this.db.prepare("SELECT * FROM agent_sessions ORDER BY flow_id,session_id")
      .all() as SessionRow[];
    const byId = new Map(rows.map((row) => [row.session_id, row]));
    for (const row of rows) {
      assertTelemetryStableId(row.session_id, "sessionId", "persisted session id");
      assertTelemetryStableId(row.flow_id, "flowId", "persisted session flow id");
      assertTelemetrySessionKind(row.kind, "persisted session kind");
      const createdAt = safeTime(row.created_at, "persisted session createdAt");
      const terminalAt = row.terminal_at === null
        ? null
        : safeTime(row.terminal_at, "persisted session terminalAt");
      const providerRef = row.provider_session_ref === null
        ? null
        : parseProviderSessionRef(parseJson(row.provider_session_ref, "persisted provider session reference"));
      if (providerRef !== null && canonicalJson(providerRef) !== row.provider_session_ref) {
        throw new Error("provider session reference integrity requires canonical JSON");
      }
      if (row.status === "created") {
        if (providerRef !== null || terminalAt !== null) {
          throw new Error("created session state integrity failure");
        }
      } else if (row.status === "running") {
        if (providerRef === null || terminalAt !== null) {
          throw new Error("running session state integrity failure");
        }
      } else if (row.status === "terminal" || row.status === "orphaned") {
        if (providerRef === null || terminalAt === null || terminalAt < createdAt) {
          throw new Error("closed session state or timestamp integrity failure");
        }
      } else {
        throw new Error("persisted session status integrity failure");
      }

      if (row.attempt_id !== null) {
        const attemptId = assertTelemetryStableId(
          row.attempt_id,
          "attemptId",
          "persisted session attempt id",
        );
        const attempt = this.db.prepare(`SELECT attempt_id,flow_id,node_id,attempt_no,session_id,status,created_at,terminal_at
          FROM graph_node_attempts WHERE flow_id=? AND attempt_id=?`)
          .get(row.flow_id, attemptId) as AttemptRow | undefined;
        if (!attempt || createdAt < attempt.created_at ||
            ((row.kind === "node_attempt") !== (row.session_id === attempt.session_id))) {
          throw new Error("session and graph attempt relational integrity failure");
        }
      } else if (row.kind === "node_attempt") {
        throw new Error("node attempt session binding integrity failure");
      }
      if (row.parent_session_id !== null) {
        const parentId = assertTelemetryStableId(
          row.parent_session_id,
          "parentSessionId",
          "persisted parent session id",
        );
        const parent = byId.get(parentId);
        if (!parent || parent.flow_id !== row.flow_id || parent.created_at > createdAt) {
          throw new Error("session ancestry relational or timestamp integrity failure");
        }
      }
    }
    for (const row of rows) {
      const visited = new Set<string>();
      let cursor: SessionRow | undefined = row;
      while (cursor !== undefined) {
        if (visited.has(cursor.session_id)) throw new Error("session ancestry cycle integrity failure");
        visited.add(cursor.session_id);
        cursor = cursor.parent_session_id === null ? undefined : byId.get(cursor.parent_session_id);
      }
    }
  }

  private verifyUsageIntegrity(): void {
    const rows = this.db.prepare("SELECT * FROM agent_attempt_usage ORDER BY usage_id").all() as UsageRow[];
    for (const row of rows) {
      const event = this.db.prepare("SELECT * FROM agent_events WHERE event_id=?").get(row.usage_id) as EventRow | undefined;
      const payload = this.db.prepare("SELECT * FROM agent_event_payloads WHERE event_id=?").get(row.usage_id) as PayloadRow | undefined;
      if (!event || event.event_type !== "attempt_usage_recorded" || event.event_version !== "1" ||
          event.event_id !== row.usage_id || event.payload_sha256 !== row.receipt_sha256 ||
          event.flow_id !== row.flow_id || event.attempt_id !== row.attempt_id ||
          event.node_id === null || event.session_id === null) {
        throw new Error("usage receipt event projection integrity failure");
      }
      const coverage = this.db.prepare(`SELECT covered_attempt_id FROM agent_usage_coverage
        WHERE usage_id=? ORDER BY covered_attempt_id`).pluck().all(row.usage_id) as string[];
      this.verifyProjectedUsageRelations(row, event, coverage);
      if (!payload) continue;
      this.verifyUsagePayloadProjection(
        row,
        event,
        payload.payload_json,
        payload.payload_sha256,
        coverage,
      );
    }
    const coverageCount = this.db.prepare("SELECT COUNT(*) FROM agent_usage_coverage").pluck().get() as number;
    const joined = this.db.prepare(`SELECT COUNT(*) FROM agent_usage_coverage c
      JOIN agent_attempt_usage u ON u.usage_id=c.usage_id AND u.flow_id=c.flow_id`).pluck().get() as number;
    if (coverageCount !== joined) throw new Error("orphan usage coverage integrity failure");
    const usageEventCount = this.db.prepare(
      "SELECT COUNT(*) FROM agent_events WHERE event_type='attempt_usage_recorded'",
    ).pluck().get() as number;
    if (usageEventCount !== rows.length) {
      throw new Error("usage receipt events and SQL projections are not one-to-one");
    }
  }

  private verifyProjectedUsageRelations(
    row: UsageRow,
    event: EventRow,
    coverage: readonly string[],
  ): void {
    assertTelemetryStableId(row.usage_id, "usageId", "usage id");
    assertTelemetryStableId(row.flow_id, "flowId", "usage flow id");
    assertTelemetryStableId(row.attempt_id, "attemptId", "usage attempt id");
    assertTelemetryProvider(row.provider, "usage provider");
    assertProviderSessionIdentity(row.provider_session_id, "usage provider session id");
    assertTelemetryStableId(row.receipt_id, "receiptId", "usage provider receipt id");
    if (!SHA256.test(row.receipt_sha256)) throw new Error("usage receipt digest integrity failure");
    const amounts = [row.input_tokens, row.output_tokens, row.cost_microusd];
    if (amounts.some((amount) => amount !== null && (!Number.isSafeInteger(amount) || amount < 0))) {
      throw new Error("usage projection contains an invalid amount");
    }
    const known = amounts.filter((amount) => amount !== null).length;
    if ((row.completeness === "exact" && known !== 3) ||
        (row.completeness === "partial" && (known === 0 || known === 3)) ||
        (row.completeness === "unavailable" && known !== 0)) {
      throw new Error("usage projection completeness conflicts with known amounts");
    }
    const ownerNode = this.db.prepare("SELECT node_id FROM graph_node_attempts WHERE flow_id=? AND attempt_id=?")
      .pluck().get(row.flow_id, row.attempt_id) as string | undefined;
    if (!ownerNode || event.node_id !== ownerNode || event.session_id === null ||
        event.created_at !== row.created_at) {
      throw new Error("usage owner attempt integrity failure");
    }
    this.validateUsageIdentityAndCoverage({
      flowId: row.flow_id,
      nodeId: ownerNode,
      attemptId: row.attempt_id,
      sessionId: event.session_id,
      providerSessionId: row.provider_session_id,
      scope: row.scope,
      coveredAttemptIds: [...coverage],
      createdAt: row.created_at,
    });
  }

  private verifyUsagePayloadProjection(
    row: UsageRow,
    event: EventRow,
    payloadJson: string,
    payloadSha256: string,
    coverage: readonly string[],
  ): void {
    const wrapper = parseJson(payloadJson, "usage receipt wrapper");
    assertExactKeys(wrapper, ["schemaVersion", "parentSessionId", "data"], "usage receipt wrapper");
    if (wrapper.schemaVersion !== "TelemetryPayload/v1") {
      throw new Error("usage receipt wrapper schema is invalid");
    }
    const data = record(wrapper.data, "usage receipt data");
    assertExactKeys(data, USAGE_RECEIPT_KEYS, "usage receipt data");
    exactRow(row, {
      usage_id: data.usageId,
      flow_id: data.flowId,
      attempt_id: data.attemptId,
      provider: data.provider,
      provider_session_id: data.providerSessionId,
      receipt_id: data.receiptId,
      scope: data.scope,
      input_tokens: data.inputTokens,
      output_tokens: data.outputTokens,
      cost_microusd: data.costMicroUsd,
      completeness: data.completeness,
      receipt_sha256: payloadSha256,
      created_at: data.createdAt,
    }, "usage DB projection");
    if (event.payload_sha256 !== payloadSha256 || data.schemaVersion !== "UsageReceipt/v1" ||
        data.coverageCount !== coverage.length || data.coverageSha256 !== computeJsonSha256(coverage)) {
      throw new Error("usage receipt body or coverage integrity failure");
    }
    this.validateNormalizedUsage(row.provider, {
      status: data.completeness,
      inputTokens: data.inputTokens,
      cachedInputTokens: data.cachedInputTokens,
      outputTokens: data.outputTokens,
      reasoningTokens: data.reasoningTokens,
      totalTokens: data.totalTokens,
      costUsd: data.costUsd,
      costMicroUsd: data.costMicroUsd,
      provenance: data.provenance,
    });
  }

  private verifyTerminalEventIntegrity(row: EventRow, payloadJson: string | undefined): void {
    if (row.event_type !== "attempt_terminal") return;
    if (row.event_version !== "1" || row.node_id === null || row.attempt_id === null || row.session_id === null ||
        row.event_id !== deriveAttemptTerminalEventId({
          flowId: row.flow_id,
          attemptId: row.attempt_id,
          eventVersion: row.event_version,
        })) {
      throw new Error("terminal receipt event identity integrity failure");
    }
    const attempt = this.db.prepare(`SELECT attempt_id,flow_id,node_id,attempt_no,session_id,status,created_at,terminal_at
      FROM graph_node_attempts WHERE flow_id=? AND node_id=? AND attempt_id=?`)
      .get(row.flow_id, row.node_id, row.attempt_id) as AttemptRow | undefined;
    const session = this.db.prepare("SELECT * FROM agent_sessions WHERE flow_id=? AND session_id=?")
      .get(row.flow_id, row.session_id) as SessionRow | undefined;
    if (!attempt || attempt.session_id !== row.session_id || !session || session.attempt_id !== row.attempt_id ||
        !["succeeded", "failed"].includes(attempt.status) || attempt.terminal_at !== row.created_at ||
        session.status !== "terminal" || session.terminal_at !== row.created_at) {
      throw new Error("terminal receipt graph/session relational integrity failure");
    }
    if (payloadJson === undefined) return;

    const wrapper = parseJson(payloadJson, "terminal receipt wrapper");
    assertExactKeys(wrapper, ["schemaVersion", "parentSessionId", "data"], "terminal receipt wrapper");
    if (wrapper.schemaVersion !== "TelemetryPayload/v1" || wrapper.parentSessionId !== session.parent_session_id) {
      throw new Error("terminal receipt wrapper integrity failure");
    }
    const data = record(wrapper.data, "terminal receipt data");
    assertExactKeys(data, TERMINAL_RECEIPT_KEYS, "terminal receipt data");
    if (data.schemaVersion !== "AttemptTerminalReceipt/v1") {
      throw new Error("terminal receipt schema integrity failure");
    }
    const { schemaVersion: _schemaVersion, ...candidate } = data;
    const parsed = this.parseTerminalInput(candidate);
    if (parsed.flowId !== row.flow_id || parsed.nodeId !== row.node_id ||
        parsed.attemptId !== row.attempt_id || parsed.sessionId !== row.session_id ||
        parsed.terminalAt !== row.created_at) {
      throw new Error("terminal receipt body conflicts with its event header");
    }
    const verifiedSession = this.validateTerminalRelations(parsed);
    if (verifiedSession.status !== "terminal" || verifiedSession.terminal_at !== parsed.terminalAt ||
        verifiedSession.parent_session_id !== wrapper.parentSessionId) {
      throw new Error("terminal receipt body conflicts with durable session state");
    }
  }

  private verifyArchiveIntegrity(): void {
    const archiveIds = this.db.prepare(`SELECT archive_id FROM agent_event_archives
      ORDER BY flow_id,first_sequence,archive_id`).pluck().all() as string[];
    const expectedAnchorIds = new Set<string>();
    const previousLastByFlow = new Map<string, number>();
    for (const archiveId of archiveIds) {
      const manifest = this.readArchiveManifest(archiveId);
      if (!manifest || manifest.members.length !== manifest.memberCount ||
          manifest.members[0]?.sequenceNo !== manifest.firstSequence ||
          manifest.members.at(-1)?.sequenceNo !== manifest.lastSequence) {
        throw new Error("archive manifest range or member integrity failure");
      }
      if (!SHA256.test(manifest.archiveId) || !SHA256.test(manifest.archiveSha256) ||
          !SHA256.test(manifest.merkleRootSha256) ||
          manifest.relativePath !== archiveRelativePath(manifest.flowId, manifest.archiveId) ||
          !Number.isSafeInteger(manifest.firstSequence) || manifest.firstSequence < 1 ||
          !Number.isSafeInteger(manifest.lastSequence) || manifest.lastSequence < manifest.firstSequence ||
          !Number.isSafeInteger(manifest.memberCount) || manifest.memberCount < 1 ||
          !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt < 0) {
        throw new Error("archive manifest identity, digest, path, or scalar integrity failure");
      }
      const previousLast = previousLastByFlow.get(manifest.flowId);
      if (previousLast !== undefined && manifest.firstSequence <= previousLast) {
        throw new Error("archive manifest ranges overlap");
      }
      previousLastByFlow.set(manifest.flowId, manifest.lastSequence);
      for (let index = 0; index < manifest.members.length; index += 1) {
        const member = manifest.members[index]!;
        const event = this.db.prepare("SELECT flow_id,event_type,payload_sha256 FROM agent_events WHERE event_id=?")
          .get(member.eventId) as { flow_id: string; event_type: string; payload_sha256: string } | undefined;
        if (member.sequenceNo !== manifest.firstSequence + index || !event || event.flow_id !== manifest.flowId ||
            event.event_type === "archive_anchor" || event.payload_sha256 !== member.payloadSha256 ||
            !SHA256.test(member.eventSha256) || !SHA256.test(member.payloadSha256)) {
          throw new Error("archive membership is non-contiguous, cross-flow, or invalid");
        }
      }

      const anchorEventId = computeJsonSha256({ archiveId: manifest.archiveId, eventVersion: "1" });
      const anchor = this.db.prepare("SELECT * FROM agent_events WHERE event_id=?").get(anchorEventId) as EventRow | undefined;
      const anchorPayload = this.db.prepare("SELECT * FROM agent_event_payloads WHERE event_id=?")
        .get(anchorEventId) as PayloadRow | undefined;
      const expectedPayload = canonicalJson({
        schemaVersion: "TelemetryPayload/v1",
        parentSessionId: null,
        data: {
          schemaVersion: "AgentEventArchiveAnchor/v1",
          archiveId: manifest.archiveId,
          archiveSha256: manifest.archiveSha256,
          merkleRootSha256: manifest.merkleRootSha256,
          firstSequence: manifest.firstSequence,
          lastSequence: manifest.lastSequence,
          memberCount: manifest.memberCount,
        },
      });
      if (!anchor || !anchorPayload || anchor.flow_id !== manifest.flowId || anchor.node_id !== null ||
          anchor.attempt_id !== null || anchor.session_id !== null || anchor.event_type !== "archive_anchor" ||
          anchor.event_version !== "1" || anchor.created_at !== manifest.createdAt ||
          anchor.sequence_no <= manifest.lastSequence || anchor.payload_sha256 !== anchorPayload.payload_sha256 ||
          anchorPayload.payload_json !== expectedPayload ||
          anchorPayload.payload_sha256 !== computeBytesSha256(expectedPayload)) {
        throw new Error("archive manifest and anchor integrity binding failed");
      }
      expectedAnchorIds.add(anchorEventId);
    }
    const actualAnchorIds = this.db.prepare("SELECT event_id FROM agent_events WHERE event_type='archive_anchor' ORDER BY event_id")
      .pluck().all() as string[];
    if (actualAnchorIds.length !== expectedAnchorIds.size ||
        actualAnchorIds.some((eventId) => !expectedAnchorIds.has(eventId))) {
      throw new Error("archive anchor has no one-to-one manifest binding");
    }
  }
}
