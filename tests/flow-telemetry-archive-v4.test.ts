import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import canonicalize from "canonicalize";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertValidGraphLifecycle,
  createTelemetryFixture,
  seedGraphAttempt,
  telemetryRows,
  terminalizeGraphAttempt,
  type TelemetryFixture,
} from "./helpers/flow-telemetry-fixture.js";

type JsonObject = Record<string, unknown>;

interface ArchiveMember {
  schemaVersion: "AgentEventArchiveMember/v1";
  flowId: string;
  eventId: string;
  sequenceNo: number;
  eventSha256: string;
  payloadSha256: string;
  payloadJson: string;
}

interface ArchiveRequest extends JsonObject {
  schemaVersion: "AgentEventArchiveRequest/v1";
  requestId: string;
  flowId: string;
  firstSequence: number;
  lastSequence: number;
  membersSha256: string;
}

interface ArchiveHeader extends JsonObject {
  schemaVersion: "AgentEventArchive/v1";
  archiveId: string;
  flowId: string;
  requestSha256: string;
  firstSequence: number;
  lastSequence: number;
  memberCount: number;
  merkleAlgorithm: string;
  merkleRootSha256: string;
  createdAt: number;
}

interface BuiltArchive {
  readonly archiveId: string;
  readonly request: ArchiveRequest;
  readonly requestSha256: string;
  readonly relativePath: string;
  readonly header: ArchiveHeader;
  readonly members: readonly ArchiveMember[];
  readonly bytes: Buffer;
  readonly archiveSha256: string;
  readonly merkleRootSha256: string;
}

interface ArchivePureRuntime {
  deriveTelemetryArchiveIdentity(input: { flowId: string; requestId: string }): {
    archiveId: string;
    relativePath: string;
  };
  buildAgentEventArchive(input: {
    flowId: string;
    requestId: string;
    createdAt: number;
    members: readonly Omit<ArchiveMember, "schemaVersion" | "flowId">[];
  }): BuiltArchive;
  verifyAgentEventArchive(archive: BuiltArchive): void;
}

interface PreparedArchive extends JsonObject {
  archiveId: string;
  requestSha256: string;
  relativePath: string;
  replayed: boolean;
  members: readonly Omit<ArchiveMember, "schemaVersion" | "flowId">[];
}

interface TelemetryStore {
  bindArchiveAuthority(authority: ArchiveStoreAuthority): void;
  createSession(input: JsonObject): unknown;
  transitionSession(input: JsonObject): unknown;
  appendEvent(input: JsonObject): unknown;
  recordUsage(input: JsonObject): { usageId: string; eventId: string; replayed: boolean };
  recordAttemptTerminal(input: JsonObject): { eventId: string; replayed: boolean };
  prepareArchive(input: JsonObject): PreparedArchive;
  commitArchiveManifest(input: JsonObject): { replayed: boolean };
  deleteArchivedPayloads(input: JsonObject): { replayed: boolean };
  close(): void;
}

interface PinnedStateFile {
  readonly absolutePath: string;
  read(): Buffer;
  assertCurrent(): void;
  close(): void;
}

interface StateFileDurability {
  publishImmutable(input: { relativePath: string; bytes: Buffer }): {
    file: PinnedStateFile;
    created: boolean;
  };
  close(): void;
}

interface ArchiveCommitCapability {}
interface ArchiveDeletionCapability {}

interface ArchiveStoreAuthority {
  bindStore(store: object): void;
}

interface ArchiveAuthority {
  readonly store: ArchiveStoreAuthority;
  readonly service: {
    issueCommitCapability(input: {
      proof: {
        file: PinnedStateFile;
        relativePath: string;
        archiveSha256: string;
        manifest: JsonObject;
        members: readonly object[];
        requestId?: string;
      };
      commit: JsonObject;
      deletion: JsonObject;
    }): ArchiveCommitCapability;
  };
}

interface FileFaultDetails extends JsonObject {
  lockBasename?: string;
  lockKey?: string;
}

interface ArchiveService {
  archive(input: JsonObject): { archiveId: string; archivePath: string; replayed: boolean };
  readPayload(input: { flowId: string; eventId: string }): { payloadJson: string; payloadSha256: string };
}

interface ArchiveRuntime {
  readonly pure: ArchivePureRuntime;
  readonly Store: new (databasePath: string, options?: {
    faultInjector?: (point: string) => void;
  }) => TelemetryStore;
  readonly Files: new (input: {
    stateRoot: string;
    faultInjector?: (point: string, details?: FileFaultDetails) => void;
  }) => StateFileDurability;
  readonly Service: new (input: {
    store: TelemetryStore;
    files: StateFileDurability;
    faultInjector?: (point: string) => void;
  }) => ArchiveService;
  readonly createAuthority: () => ArchiveAuthority;
}

const roots: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1_000;
const GIB = 1_024n * 1_024n * 1_024n;
const WORKER_TIMEOUT_MS = 10_000;
const WORKER_CLEANUP_TIMEOUT_MS = 2_000;
const MAX_ARCHIVE_REQUEST_ID_LENGTH = 128;
const MERKLE_ALGORITHM = "sha256-0x00-leaf-0x01-parent-duplicate-odd/v1";
const FILE_FAULT_POINTS = {
  afterFileFsync: "after_file_fsync",
  afterRename: "after_rename",
  afterDirectoryFsync: "after_directory_fsync",
  beforeLock: "before_lock_acquire",
  contendedLock: "after_lock_contended",
  acquiredLock: "after_lock_acquired",
} as const;
const SERVICE_FAULT_POINTS = {
  afterValidation: "after_archive_segment_validation",
  afterManifest: "after_archive_manifest_commit",
} as const;
const REQUEST_KEYS = [
  "schemaVersion", "requestId", "flowId", "firstSequence", "lastSequence", "membersSha256",
] as const;
const HEADER_KEYS = [
  "schemaVersion", "archiveId", "flowId", "requestSha256", "firstSequence", "lastSequence",
  "memberCount", "merkleAlgorithm", "merkleRootSha256", "createdAt",
] as const;
const MEMBER_KEYS = [
  "schemaVersion", "flowId", "eventId", "sequenceNo", "eventSha256", "payloadSha256", "payloadJson",
] as const;

interface ArchiveFlowIdentity {
  readonly flowId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly workflowId: string;
  readonly sessionId: string;
  readonly eventPrefix: string;
}

interface ArchiveInvocation extends JsonObject {
  flowId: string;
  requestId: string;
  firstSequence: number;
  lastSequence: number;
  now: number;
  databaseBytes: bigint;
}

type ArchiveFlowStatus = "running" | "succeeded" | "failed" | "cancelled" | "needs_reconciliation";

interface SeededArchiveFlow {
  readonly identity: ArchiveFlowIdentity;
  readonly eventIds: readonly string[];
  readonly payloads: readonly string[];
}

const DEFAULT_ARCHIVE_FLOW: ArchiveFlowIdentity = {
  flowId: "flow-b",
  nodeId: "node-other",
  attemptId: "attempt-other",
  workflowId: "workflow-other",
  sessionId: "session-other",
  eventPrefix: "event-b",
};
const SECOND_ARCHIVE_FLOW: ArchiveFlowIdentity = {
  flowId: "flow-a",
  nodeId: "node-a",
  attemptId: "attempt-a",
  workflowId: "workflow-a",
  sessionId: "session-a",
  eventPrefix: "event-a",
};

const fixture = (): TelemetryFixture => {
  const created = createTelemetryFixture();
  roots.push(created.root);
  return created;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function loadRuntime(): Promise<ArchiveRuntime> {
  const [pure, store, files, service, authority] = await Promise.all([
    import(pathToFileURL(resolve("src/runtime/flow-telemetry-archive.ts")).href),
    import(pathToFileURL(resolve("src/store/flow-telemetry-store.ts")).href),
    import(pathToFileURL(resolve("src/store/state-file-durability.ts")).href),
    import(pathToFileURL(resolve("src/app/flow-telemetry-archive-service.ts")).href),
    import(pathToFileURL(resolve("src/app/flow-telemetry-archive-authority.ts")).href),
  ]);
  return {
    pure: pure as unknown as ArchivePureRuntime,
    Store: store.FlowTelemetryStore as ArchiveRuntime["Store"],
    Files: files.StateFileDurability as ArchiveRuntime["Files"],
    Service: service.FlowTelemetryArchiveService as ArchiveRuntime["Service"],
    createAuthority: authority.createFlowTelemetryArchiveAuthority as ArchiveRuntime["createAuthority"],
  };
}

async function loadPureRuntime(): Promise<ArchivePureRuntime> {
  return await import(pathToFileURL(resolve("src/runtime/flow-telemetry-archive.ts")).href) as unknown as ArchivePureRuntime;
}

const canonicalJson = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new Error("test value is not canonicalizable");
  return encoded;
};
const digest = (bytes: string | Buffer): Buffer => createHash("sha256").update(bytes).digest();
const hex = (bytes: string | Buffer): string => digest(bytes).toString("hex");

function oracleArchiveIdentity(flowId: string, requestId: string): {
  archiveId: string;
  relativePath: string;
} {
  const archiveId = hex(canonicalJson({ flowId, requestId }));
  return {
    archiveId,
    relativePath: `telemetry-archives/${hex(flowId)}/${hex(archiveId)}.jsonl`,
  };
}

function validArchiveMembers(
  count = 3,
  flowId = "flow-a",
): Array<Omit<ArchiveMember, "schemaVersion" | "flowId">> {
  let previousEventSha256: string | null = null;
  return Array.from({ length: count }, (_, index) => {
    const sequenceNo = index + 1;
    const eventId = `event-${sequenceNo}`;
    const payloadJson = canonicalJson({
      schemaVersion: "TelemetryPayload/v1",
      parentSessionId: null,
      data: { sequence: sequenceNo },
    });
    const payloadSha256 = hex(payloadJson);
    const unsigned = {
      schemaVersion: "FlowEvent/v1",
      eventId,
      flowId,
      sequenceNo,
      nodeId: "node-a",
      attemptId: "attempt-a",
      sessionId: "session-a",
      eventType: "progress",
      eventVersion: "1",
      payloadSha256,
      previousEventSha256,
      parentSessionId: null,
      traceId: null,
      spanId: null,
      createdAt: 1_100 + sequenceNo,
    };
    const eventSha256 = hex(canonicalJson(unsigned));
    previousEventSha256 = eventSha256;
    return { eventId, sequenceNo, eventSha256, payloadSha256, payloadJson };
  });
}

function expectedMerkle(members: readonly ArchiveMember[]): string {
  let level = members.map((member) => digest(Buffer.concat([
    Buffer.from([0]),
    Buffer.from(canonicalJson(member)),
  ])));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1] ?? left;
      next.push(digest(Buffer.concat([Buffer.from([1]), left, right])));
    }
    level = next;
  }
  if (!level[0]) throw new Error("test Merkle tree cannot be empty");
  return level[0].toString("hex");
}

function oracleArchive(input: {
  flowId: string;
  requestId: string;
  createdAt: number;
  members: readonly Omit<ArchiveMember, "schemaVersion" | "flowId">[];
}): BuiltArchive {
  const identity = oracleArchiveIdentity(input.flowId, input.requestId);
  const members = input.members.map((member): ArchiveMember => ({
    schemaVersion: "AgentEventArchiveMember/v1",
    flowId: input.flowId,
    ...member,
  }));
  if (members.length === 0) throw new Error("test archive cannot be empty");
  const request: ArchiveRequest = {
    schemaVersion: "AgentEventArchiveRequest/v1",
    requestId: input.requestId,
    flowId: input.flowId,
    firstSequence: members[0]!.sequenceNo,
    lastSequence: members.at(-1)!.sequenceNo,
    membersSha256: hex(canonicalJson(members)),
  };
  const requestSha256 = hex(canonicalJson(request));
  const merkleRootSha256 = expectedMerkle(members);
  const header: ArchiveHeader = {
    schemaVersion: "AgentEventArchive/v1",
    archiveId: identity.archiveId,
    flowId: input.flowId,
    requestSha256,
    firstSequence: request.firstSequence,
    lastSequence: request.lastSequence,
    memberCount: members.length,
    merkleAlgorithm: MERKLE_ALGORITHM,
    merkleRootSha256,
    createdAt: input.createdAt,
  };
  const bytes = Buffer.from(`${[header, ...members].map(canonicalJson).join("\n")}\n`);
  return {
    archiveId: identity.archiveId,
    request,
    requestSha256,
    relativePath: identity.relativePath,
    header,
    members,
    bytes,
    archiveSha256: hex(bytes),
    merkleRootSha256,
  };
}

function changedScalar(value: unknown): unknown {
  if (typeof value === "number") return value + 1;
  if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) {
    return `${value.startsWith("0") ? "1" : "0"}${value.slice(1)}`;
  }
  if (typeof value === "string") return `${value}:changed`;
  return "changed";
}

function changeField(input: JsonObject, key: string): JsonObject {
  return { ...input, [key]: changedScalar(input[key]) };
}

function removeField(input: JsonObject, key: string): JsonObject {
  const changed = { ...input };
  delete changed[key];
  return changed;
}

function mutateRawLine(
  archive: BuiltArchive,
  lineIndex: number,
  mutate: (line: JsonObject) => JsonObject,
): BuiltArchive {
  const text = archive.bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error("oracle archive must end in LF");
  const lines = text.slice(0, -1).split("\n");
  const parsed = JSON.parse(lines[lineIndex]!) as JsonObject;
  lines[lineIndex] = canonicalJson(mutate(parsed));
  return { ...archive, bytes: Buffer.from(`${lines.join("\n")}\n`) };
}

function rehashArchive(input: BuiltArchive, changes: {
  request?: ArchiveRequest;
  header?: ArchiveHeader;
  members?: readonly ArchiveMember[];
}): BuiltArchive {
  const request = changes.request ?? input.request;
  const requestSha256 = hex(canonicalJson(request));
  const members = changes.members ?? input.members;
  const merkleRootSha256 = expectedMerkle(members);
  const header = {
    ...(changes.header ?? input.header),
    requestSha256,
    merkleRootSha256,
  } satisfies ArchiveHeader;
  const bytes = Buffer.from(`${[header, ...members].map(canonicalJson).join("\n")}\n`);
  return {
    ...input,
    request,
    requestSha256,
    header,
    members,
    bytes,
    archiveSha256: hex(bytes),
    merkleRootSha256,
  };
}

type FieldTamperOperation = "change" | "remove" | "extra";

interface FieldTamperCase {
  readonly scope: "header" | "member";
  readonly key: string;
  readonly operation: FieldTamperOperation;
  readonly label: string;
}

const REQUEST_TAMPER_CASES = [
  ...REQUEST_KEYS.flatMap((key) => ([
    { key, operation: "change" as const, label: `request.${key} changed` },
    { key, operation: "remove" as const, label: `request.${key} missing` },
  ])),
  { key: "unexpected", operation: "extra" as const, label: "request unexpected key" },
];

const ARCHIVE_FILE_TAMPER_CASES: readonly FieldTamperCase[] = [
  ...HEADER_KEYS.flatMap((key) => ([
    { scope: "header" as const, key, operation: "change" as const, label: `header.${key} changed` },
    { scope: "header" as const, key, operation: "remove" as const, label: `header.${key} missing` },
  ])),
  { scope: "header", key: "unexpected", operation: "extra", label: "header unexpected key" },
  ...MEMBER_KEYS.flatMap((key) => ([
    { scope: "member" as const, key, operation: "change" as const, label: `member.${key} changed` },
    { scope: "member" as const, key, operation: "remove" as const, label: `member.${key} missing` },
  ])),
  { scope: "member", key: "unexpected", operation: "extra", label: "member unexpected key" },
];

function applyFieldTamper(
  input: JsonObject,
  key: string,
  operation: FieldTamperOperation,
): JsonObject {
  if (operation === "extra") return { ...input, unexpected: true };
  if (operation === "remove") return removeField(input, key);
  return changeField(input, key);
}

function serializeArchiveCandidate(input: {
  expected: BuiltArchive;
  request: ArchiveRequest;
  header: ArchiveHeader;
  members: readonly ArchiveMember[];
}): BuiltArchive {
  const bytes = Buffer.from(`${[input.header, ...input.members].map(canonicalJson).join("\n")}\n`);
  return {
    archiveId: input.header.archiveId,
    request: input.request,
    requestSha256: input.header.requestSha256,
    relativePath: input.expected.relativePath,
    header: input.header,
    members: input.members,
    bytes,
    archiveSha256: hex(bytes),
    merkleRootSha256: input.header.merkleRootSha256,
  };
}

function selfConsistentRequestTamper(
  expected: BuiltArchive,
  input: { key: string; operation: FieldTamperOperation },
): BuiltArchive {
  const request = applyFieldTamper(
    expected.request,
    input.key,
    input.operation,
  ) as ArchiveRequest;
  const header = {
    ...expected.header,
    requestSha256: hex(canonicalJson(request)),
  };
  return serializeArchiveCandidate({ expected, request, header, members: expected.members });
}

function selfConsistentArchiveFileTamper(expected: BuiltArchive, input: FieldTamperCase): BuiltArchive {
  let request = { ...expected.request };
  let header = { ...expected.header };
  let members = expected.members.map((member) => ({ ...member }));
  if (input.scope === "header") {
    header = applyFieldTamper(header, input.key, input.operation) as ArchiveHeader;
  } else {
    members[0] = applyFieldTamper(
      members[0]! as unknown as JsonObject,
      input.key,
      input.operation,
    ) as unknown as ArchiveMember;
    request = {
      ...request,
      membersSha256: hex(canonicalJson(members)),
    };
    header = {
      ...header,
      requestSha256: hex(canonicalJson(request)),
      merkleRootSha256: expectedMerkle(members),
    };
  }
  return serializeArchiveCandidate({ expected, request, header, members });
}

function archivePathFor(state: TelemetryFixture, flowId: string, requestId: string): string {
  return join(dirname(state.databasePath), oracleArchiveIdentity(flowId, requestId).relativePath);
}

function authorityFileProof(expected: BuiltArchive, file: PinnedStateFile): {
  file: PinnedStateFile;
  relativePath: string;
  archiveSha256: string;
  manifest: JsonObject;
  members: readonly ArchiveMember[];
  requestId: string;
} {
  return {
    file,
    relativePath: expected.relativePath,
    archiveSha256: expected.archiveSha256,
    manifest: {
      archiveId: expected.archiveId,
      flowId: expected.header.flowId,
      firstSequence: expected.header.firstSequence,
      lastSequence: expected.header.lastSequence,
      relativePath: expected.relativePath,
      archiveSha256: expected.archiveSha256,
      merkleRootSha256: expected.merkleRootSha256,
      memberCount: expected.header.memberCount,
      createdAt: expected.header.createdAt,
    },
    members: expected.members,
    requestId: expected.request.requestId,
  };
}

function archiveDataFiles(state: TelemetryFixture): string[] {
  const archiveRoot = join(dirname(state.databasePath), "telemetry-archives");
  if (!existsSync(archiveRoot)) return [];
  const paths: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (!entry.name.endsWith(".lock")) paths.push(child);
    }
  };
  visit(archiveRoot);
  return paths.sort();
}

function archiveFileSnapshot(state: TelemetryFixture): Array<{ path: string; bytesBase64: string }> {
  return archiveDataFiles(state).map((path) => ({
    path,
    bytesBase64: readFileSync(path).toString("base64"),
  }));
}

function stateDatabaseFileSnapshot(databasePath: string): Array<{
  path: string;
  exists: boolean;
  bytesBase64: string | null;
}> {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map((path) => {
    const exists = existsSync(path);
    return {
      path,
      exists,
      bytesBase64: exists ? readFileSync(path).toString("base64") : null,
    };
  });
}

function expectedArchiveFromFixture(
  state: TelemetryFixture,
  request: ArchiveInvocation,
): BuiltArchive {
  const db = new Database(state.databasePath, { readonly: true });
  try {
    const rows = db.prepare(`SELECT e.*,p.payload_json
      FROM agent_events e JOIN agent_event_payloads p ON p.event_id=e.event_id
      WHERE e.flow_id=? AND e.sequence_no BETWEEN ? AND ? AND e.event_type<>'archive_anchor'
      ORDER BY e.sequence_no`).all(
        request.flowId,
        request.firstSequence,
        request.lastSequence,
      ) as Array<Record<string, unknown> & {
        event_id: string;
        sequence_no: number;
        event_sha256: string;
        payload_sha256: string;
        payload_json: string;
      }>;
    if (rows.length !== request.lastSequence - request.firstSequence + 1 ||
        rows[0]?.sequence_no !== request.firstSequence || rows.at(-1)?.sequence_no !== request.lastSequence) {
      throw new Error("independent archive oracle requires one live payload per contiguous sequence");
    }
    for (const row of rows) {
      if (row.payload_sha256 !== hex(row.payload_json) ||
          row.event_sha256 !== eventShaFromRow(row, row.payload_json)) {
        throw new Error("independent archive oracle found a non-canonical event or payload digest");
      }
    }
    return oracleArchive({
      flowId: request.flowId,
      requestId: request.requestId,
      createdAt: request.now,
      members: rows.map((row) => ({
        eventId: row.event_id,
        sequenceNo: row.sequence_no,
        eventSha256: row.event_sha256,
        payloadSha256: row.payload_sha256,
        payloadJson: row.payload_json,
      })),
    });
  } finally {
    db.close();
  }
}

function terminalEnvelope(input: {
  identity: ArchiveFlowIdentity;
  nodeId: string;
  attemptId: string | null;
  attemptNo: number;
  outcome: "succeeded" | "failed" | "cancelled" | "skipped";
  terminalAt: number;
}): { envelopeJson: string; envelopeSha256: string; resultJson: string | null; resultSha256: string | null } {
  const result = input.outcome === "succeeded" ? { complete: true } : null;
  const resultJson = result === null ? null : canonicalJson(result);
  const envelopeJson = canonicalJson({
    schemaVersion: "GraphNodeTerminalEnvelope/v1",
    flowId: input.identity.flowId,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    attemptNo: input.attemptNo,
    outcome: input.outcome,
    createdAt: input.terminalAt,
  });
  return {
    envelopeJson,
    envelopeSha256: hex(envelopeJson),
    resultJson,
    resultSha256: resultJson === null ? null : hex(resultJson),
  };
}

function insertTerminalResult(db: Database.Database, input: {
  identity: ArchiveFlowIdentity;
  nodeId: string;
  attemptId: string | null;
  attemptNo: number;
  outcome: "succeeded" | "failed" | "cancelled" | "skipped";
  terminalAt: number;
}): void {
  const terminal = terminalEnvelope(input);
  db.prepare(`INSERT OR IGNORE INTO graph_node_results
    (result_id,flow_id,node_id,attempt_id,attempt_no,outcome,terminal_envelope_json,
     terminal_envelope_sha256,result_json,result_sha256,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.attemptId === null ? `result:skipped:${input.nodeId}` : `result:${input.attemptId}`,
      input.identity.flowId,
      input.nodeId,
      input.attemptId,
      input.attemptNo,
      input.outcome,
      terminal.envelopeJson,
      terminal.envelopeSha256,
      terminal.resultJson,
      terminal.resultSha256,
      input.terminalAt,
    );
}

function seedSecondarySuccessAttempts(
  Store: ArchiveRuntime["Store"],
  state: TelemetryFixture,
  terminalAt: number,
): void {
  if (terminalAt < 1_250) throw new Error("child fixture terminal time precedes its running transition");
  for (const suffix of ["b", "c"] as const) {
    const nodeId = `node-${suffix}` as "node-b" | "node-c";
    const attemptId = `attempt-${suffix}`;
    const workflowId = `workflow-${suffix}`;
    const sessionId = `session-${suffix}`;
    seedGraphAttempt(state.databasePath, {
      flowId: "flow-a",
      nodeId,
      attemptId,
      attemptNo: 1,
      workflowId,
      sessionId,
    });
    const store = new Store(state.databasePath);
    try {
      store.createSession({
        sessionId,
        flowId: "flow-a",
        attemptId,
        parentSessionId: "session-a",
        kind: "node_attempt",
        createdAt: 1_200,
      });
      store.transitionSession({
        flowId: "flow-a",
        sessionId,
        expectedStatus: "created",
        status: "running",
        providerSessionRef: {
          schemaVersion: "ProviderSessionRef/v1",
          value: `provider-${sessionId}`,
          provenance: "provider_reported",
        },
        now: 1_250,
      });
      store.transitionSession({
        flowId: "flow-a",
        sessionId,
        expectedStatus: "running",
        status: "terminal",
        now: terminalAt,
      });
    } finally {
      store.close();
    }
  }
}

function applyArchiveFlowLifecycle(
  state: TelemetryFixture,
  identity: ArchiveFlowIdentity,
  status: ArchiveFlowStatus,
  updatedAt: number,
): void {
  const db = new Database(state.databasePath);
  db.pragma("foreign_keys = ON");
  try {
    db.transaction(() => {
      db.prepare("UPDATE graph_flows SET status=?,version=version+1,updated_at=? WHERE flow_id=?")
        .run(status, updatedAt, identity.flowId);
      if (status === "running") {
        db.prepare(`UPDATE graph_nodes SET version=version+1,updated_at=?
          WHERE flow_id=? AND node_id=? AND status='running'`).run(updatedAt, identity.flowId, identity.nodeId);
        return;
      }
      if (status === "needs_reconciliation") {
        db.prepare(`UPDATE graph_nodes SET status='needs_reconciliation',version=version+1,updated_at=?
          WHERE flow_id=? AND node_id=?`).run(updatedAt, identity.flowId, identity.nodeId);
        db.prepare(`UPDATE graph_node_attempts SET status='needs_reconciliation',terminal_at=NULL
          WHERE flow_id=? AND attempt_id=?`).run(identity.flowId, identity.attemptId);
        return;
      }

      db.prepare("UPDATE graph_nodes SET status=?,version=version+1,updated_at=? WHERE flow_id=? AND node_id=?")
        .run(status, updatedAt, identity.flowId, identity.nodeId);
      db.prepare(`UPDATE graph_node_attempts SET status=?,terminal_at=?
        WHERE flow_id=? AND attempt_id=? AND status='running'`)
        .run(status, updatedAt, identity.flowId, identity.attemptId);
      insertTerminalResult(db, {
        identity,
        nodeId: identity.nodeId,
        attemptId: identity.attemptId,
        attemptNo: 1,
        outcome: status,
        terminalAt: updatedAt,
      });

      if (identity.flowId === "flow-a" && status === "succeeded") {
        for (const suffix of ["b", "c"] as const) {
          const nodeId = `node-${suffix}`;
          const attemptId = `attempt-${suffix}`;
          db.prepare(`UPDATE graph_nodes SET status='succeeded',version=version+1,updated_at=?
            WHERE flow_id='flow-a' AND node_id=?`).run(updatedAt, nodeId);
          db.prepare(`UPDATE graph_node_attempts SET status='succeeded',terminal_at=?
            WHERE flow_id='flow-a' AND attempt_id=?`).run(updatedAt, attemptId);
          insertTerminalResult(db, {
            identity,
            nodeId,
            attemptId,
            attemptNo: 1,
            outcome: "succeeded",
            terminalAt: updatedAt,
          });
          const edgeId = `node-a-${nodeId}`;
          const edgeEnvelope = canonicalJson({
            schemaVersion: "GraphEdgeEvaluation/v1",
            flowId: "flow-a",
            edgeId,
            sourceAttemptNo: 1,
            decision: "activated",
          });
          db.prepare(`INSERT OR IGNORE INTO graph_edge_evaluations
            (flow_id,edge_id,source_attempt_no,decision,envelope_sha256,evaluator_version,created_at)
            VALUES ('flow-a',?,1,'activated',?,'fixture/v1',?)`).run(edgeId, hex(edgeEnvelope), updatedAt);
        }
      }
    }).immediate();
  } finally {
    db.close();
  }
}

function assertArchiveFlowLifecycle(
  state: TelemetryFixture,
  identity: ArchiveFlowIdentity,
  status: ArchiveFlowStatus,
  updatedAt: number,
): void {
  assertValidGraphLifecycle(state.databasePath);
  const rows = telemetryRows(state.databasePath);
  const flow = rows.graph_flows!.filter(({ flow_id }) => flow_id === identity.flowId);
  const nodes = rows.graph_nodes!.filter(({ flow_id }) => flow_id === identity.flowId);
  const attempts = rows.graph_node_attempts!.filter(({ flow_id }) => flow_id === identity.flowId);
  const sessions = rows.agent_sessions!.filter(({ flow_id }) => flow_id === identity.flowId);
  const results = rows.graph_node_results!.filter(({ flow_id }) => flow_id === identity.flowId);
  expect(flow).toEqual([expect.objectContaining({ status, updated_at: updatedAt })]);
  const rootTerminalAt = ["succeeded", "failed", "cancelled"].includes(status)
    ? identity.flowId === "flow-a" && status === "succeeded" ? 1_100 : updatedAt
    : null;
  expect(attempts.find(({ attempt_id }) => attempt_id === identity.attemptId)).toEqual(expect.objectContaining({
    status,
    terminal_at: rootTerminalAt,
  }));
  expect(nodes.find(({ node_id }) => node_id === identity.nodeId)).toEqual(expect.objectContaining({
    status,
    updated_at: updatedAt,
  }));
  expect(sessions.find(({ session_id }) => session_id === identity.sessionId)).toEqual(expect.objectContaining({
    status: status === "running" ? "running" : status === "needs_reconciliation" ? "orphaned" : "terminal",
    terminal_at: status === "running" ? null : rootTerminalAt ?? updatedAt,
  }));
  if (["succeeded", "failed", "cancelled"].includes(status)) {
    expect(results.find(({ node_id }) => node_id === identity.nodeId)).toEqual(expect.objectContaining({
      attempt_id: identity.attemptId,
      attempt_no: 1,
      outcome: status,
      created_at: rootTerminalAt,
    }));
  } else {
    expect(results).toEqual([]);
  }
  if (identity.flowId === "flow-a" && status === "succeeded") {
    expect(nodes.map(({ node_id, status: nodeStatus, updated_at }) => ({ node_id, status: nodeStatus, updated_at })))
      .toEqual([
        { node_id: "node-a", status: "succeeded", updated_at: updatedAt },
        { node_id: "node-b", status: "succeeded", updated_at: updatedAt },
        { node_id: "node-c", status: "succeeded", updated_at: updatedAt },
      ]);
    expect(attempts.map(({ attempt_id, status: attemptStatus, terminal_at }) => ({
      attempt_id, status: attemptStatus, terminal_at,
    }))).toEqual([
      { attempt_id: "attempt-a", status: "succeeded", terminal_at: 1_100 },
      { attempt_id: "attempt-b", status: "succeeded", terminal_at: updatedAt },
      { attempt_id: "attempt-c", status: "succeeded", terminal_at: updatedAt },
    ]);
    expect(sessions.map(({ session_id, parent_session_id, status: sessionStatus, terminal_at }) => ({
      session_id, parent_session_id, status: sessionStatus, terminal_at,
    }))).toEqual([
      { session_id: "session-a", parent_session_id: null, status: "terminal", terminal_at: 1_100 },
      { session_id: "session-b", parent_session_id: "session-a", status: "terminal", terminal_at: updatedAt },
      { session_id: "session-c", parent_session_id: "session-a", status: "terminal", terminal_at: updatedAt },
    ]);
    expect(results.map(({ node_id, outcome, created_at }) => ({ node_id, outcome, created_at }))).toEqual([
      { node_id: "node-a", outcome: "succeeded", created_at: 1_100 },
      { node_id: "node-b", outcome: "succeeded", created_at: updatedAt },
      { node_id: "node-c", outcome: "succeeded", created_at: updatedAt },
    ]);
    expect(rows.graph_edge_evaluations!.filter(({ flow_id }) => flow_id === "flow-a"))
      .toEqual([
        expect.objectContaining({ edge_id: "node-a-node-b", decision: "activated" }),
        expect.objectContaining({ edge_id: "node-a-node-c", decision: "activated" }),
      ]);
  }
}

function seedArchivableEvents(
  Store: ArchiveRuntime["Store"],
  state: TelemetryFixture,
  count = 3,
  identity: ArchiveFlowIdentity = DEFAULT_ARCHIVE_FLOW,
  status: ArchiveFlowStatus = "succeeded",
  updatedAt = 1_400,
): SeededArchiveFlow {
  const store = new Store(state.databasePath);
  const payloads: string[] = [];
  const eventIds: string[] = [];
  try {
    store.createSession({
      sessionId: identity.sessionId,
      flowId: identity.flowId,
      attemptId: identity.attemptId,
      parentSessionId: null,
      kind: "node_attempt",
      createdAt: 1_000,
    });
    store.transitionSession({
      flowId: identity.flowId,
      sessionId: identity.sessionId,
      expectedStatus: "created",
      status: "running",
      providerSessionRef: {
        schemaVersion: "ProviderSessionRef/v1",
        value: `provider-${identity.sessionId}`,
        provenance: "provider_reported",
      },
      now: 1_010,
    });
    for (let sequence = 1; sequence <= count; sequence += 1) {
      const payload = {
        schemaVersion: "TelemetryPayload/v1", parentSessionId: null, data: { sequence },
      };
      payloads.push(canonicalJson(payload));
      const eventId = `${identity.eventPrefix}-${sequence}`;
      eventIds.push(eventId);
      store.appendEvent({
        eventId,
        flowId: identity.flowId,
        nodeId: identity.nodeId,
        attemptId: identity.attemptId,
        sessionId: identity.sessionId,
        eventType: "progress",
        eventVersion: "1",
        payload,
        parentSessionId: null,
        traceId: null,
        spanId: null,
        createdAt: 1_020 + sequence,
      });
    }
    if (status !== "running") {
      store.transitionSession({
        flowId: identity.flowId,
        sessionId: identity.sessionId,
        expectedStatus: "running",
        status: status === "needs_reconciliation" ? "orphaned" : "terminal",
        now: identity.flowId === "flow-a" && status === "succeeded" ? 1_100 : updatedAt,
      });
    }
  } finally {
    store.close();
  }
  if (identity.flowId === "flow-a" && status === "succeeded") {
    seedSecondarySuccessAttempts(Store, state, updatedAt);
  }
  applyArchiveFlowLifecycle(state, identity, status, updatedAt);
  assertArchiveFlowLifecycle(state, identity, status, updatedAt);
  return { identity, eventIds, payloads };
}

function seedArchivableUsageAndTerminal(
  Store: ArchiveRuntime["Store"],
  state: TelemetryFixture,
  providerSessionId = `provider-${DEFAULT_ARCHIVE_FLOW.sessionId}`,
): {
  readonly seeded: SeededArchiveFlow;
  readonly usageInput: JsonObject;
  readonly terminalInput: JsonObject;
} {
  const identity = DEFAULT_ARCHIVE_FLOW;
  const usageInput: JsonObject = {
    flowId: identity.flowId,
    nodeId: identity.nodeId,
    attemptId: identity.attemptId,
    sessionId: identity.sessionId,
    usageId: "usage-archive-exact",
    provider: "codex",
    providerSessionId,
    receiptId: "receipt-archive-exact",
    scope: "self",
    coveredAttemptIds: [],
    normalizedUsage: {
      status: "exact",
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 5,
      reasoningTokens: 1,
      totalTokens: 15,
      costUsd: 0.0042,
      costMicroUsd: 4_200,
      provenance: {
        inputTokens: "provider_reported",
        cachedInputTokens: "provider_reported",
        outputTokens: "provider_reported",
        reasoningTokens: "provider_reported",
        totalTokens: "provider_reported",
        costUsd: "provider_reported",
        costMicroUsd: "lossless_usd_to_microusd",
      },
    },
    createdAt: 1_300,
  };
  const terminalInput: JsonObject = {
    flowId: identity.flowId,
    nodeId: identity.nodeId,
    attemptId: identity.attemptId,
    sessionId: identity.sessionId,
    provider: "codex",
    attemptOrdinal: 1,
    outcome: "succeeded",
    errorClassification: null,
    startedAt: 1_000,
    terminalAt: 1_400,
    usageObservation: { status: "exact", usageId: usageInput.usageId },
  };
  const store = new Store(state.databasePath);
  let terminalEventId: string;
  try {
    store.createSession({
      sessionId: identity.sessionId,
      flowId: identity.flowId,
      attemptId: identity.attemptId,
      parentSessionId: null,
      kind: "node_attempt",
      createdAt: 1_000,
    });
    store.transitionSession({
      flowId: identity.flowId,
      sessionId: identity.sessionId,
      expectedStatus: "created",
      status: "running",
      providerSessionRef: {
        schemaVersion: "ProviderSessionRef/v1",
        value: providerSessionId,
        provenance: "provider_reported",
      },
      now: 1_010,
    });
    expect(store.recordUsage(usageInput)).toEqual({
      usageId: usageInput.usageId,
      eventId: usageInput.usageId,
      replayed: false,
    });
    terminalizeGraphAttempt(state.databasePath, {
      flowId: identity.flowId,
      nodeId: identity.nodeId,
      attemptId: identity.attemptId,
      status: "succeeded",
      terminalAt: 1_400,
    });
    const terminal = store.recordAttemptTerminal(terminalInput);
    expect(terminal.replayed).toBe(false);
    terminalEventId = terminal.eventId;
  } finally {
    store.close();
  }
  applyArchiveFlowLifecycle(state, identity, "succeeded", 1_400);
  assertArchiveFlowLifecycle(state, identity, "succeeded", 1_400);
  const payloadRows = telemetryRows(state.databasePath).agent_event_payloads!;
  const eventIds = [String(usageInput.usageId), terminalEventId];
  const payloads = eventIds.map((eventId) => {
    const row = payloadRows.find(({ event_id }) => event_id === eventId);
    if (!row) throw new Error(`archive usage fixture is missing payload ${eventId}`);
    return String(row.payload_json);
  });
  return { seeded: { identity, eventIds, payloads }, usageInput, terminalInput };
}

function serviceFor(runtime: ArchiveRuntime, state: TelemetryFixture, input: {
  fileFault?: (point: string, details?: FileFaultDetails) => void;
  serviceFault?: (point: string) => void;
} = {}): { store: TelemetryStore; files: StateFileDurability; service: ArchiveService } {
  const store = new runtime.Store(state.databasePath);
  let files: StateFileDurability | undefined;
  try {
    files = new runtime.Files({
      stateRoot: dirname(state.databasePath),
      ...(input.fileFault ? { faultInjector: input.fileFault } : {}),
    });
    return {
      store,
      files,
      service: new runtime.Service({
        store,
        files,
        ...(input.serviceFault ? { faultInjector: input.serviceFault } : {}),
      }),
    };
  } catch (error) {
    files?.close();
    store.close();
    throw error;
  }
}

const archiveRequest = (overrides: JsonObject = {}): ArchiveInvocation => ({
  flowId: DEFAULT_ARCHIVE_FLOW.flowId,
  requestId: "archive-request-a",
  firstSequence: 1,
  lastSequence: 3,
  now: 1_800_000_000_000,
  databaseBytes: 0n,
  ...overrides,
}) as ArchiveInvocation;

const WORKER_CELL = {
  ready: 0,
  start: 1,
  beforeAcquire: 2,
  contended: 3,
  acquired: 4,
  release: 5,
  completed: 6,
} as const;

interface ArchiveWorkerHandle {
  readonly label: string;
  readonly worker: Worker;
  readonly sync: Int32Array;
  readonly timeoutMs: number;
  readonly exited: Promise<number>;
  readonly terminate: () => Promise<number>;
  outcome: Promise<JsonObject>;
  settled?: JsonObject;
}

function startArchiveWorker(input: {
  databasePath: string;
  archiveInput: JsonObject;
  label: string;
  holdAfterAcquire?: boolean;
  hangAfterAcquire?: boolean;
  timeoutMs?: number;
}): ArchiveWorkerHandle {
  const timeoutMs = input.timeoutMs ?? WORKER_TIMEOUT_MS;
  const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 7);
  const sync = new Int32Array(control);
  const worker = new Worker(
    new URL("./fixtures/flow-telemetry-archive-worker.mjs", import.meta.url),
    {
      workerData: {
        databasePath: input.databasePath,
        input: input.archiveInput,
        control,
        holdAfterAcquire: input.holdAfterAcquire === true,
        hangAfterAcquire: input.hangAfterAcquire === true,
        timeoutMs,
        faultPoints: {
          beforeLock: FILE_FAULT_POINTS.beforeLock,
          contendedLock: FILE_FAULT_POINTS.contendedLock,
          acquiredLock: FILE_FAULT_POINTS.acquiredLock,
        },
      },
      execArgv: ["--import", "tsx"],
    },
  );
  const exited = new Promise<number>((resolveExit) => worker.once("exit", resolveExit));
  let termination: Promise<number> | undefined;
  const terminate = (): Promise<number> => {
    termination ??= Promise.resolve(worker.terminate());
    return termination;
  };
  const handle = { label: input.label, worker, sync, timeoutMs, exited, terminate } as ArchiveWorkerHandle;
  handle.outcome = new Promise<JsonObject>((resolveOutcome) => {
    let finished = false;
    const finish = (outcome: JsonObject): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      handle.settled = outcome;
      resolveOutcome(outcome);
    };
    const timeout = setTimeout(() => {
      finish({ ok: false, harnessError: `${input.label} exceeded ${timeoutMs}ms` });
      void terminate().catch(() => undefined);
    }, timeoutMs);
    worker.once("message", (message: unknown) => finish(message as JsonObject));
    worker.once("error", (error) => finish({ ok: false, harnessError: error.message }));
    worker.once("exit", (code) => {
      if (!finished) finish({ ok: false, harnessError: `${input.label} exited ${code} without a result` });
    });
  });
  return handle;
}

function startDatabaseRaceWorker(input: {
  databasePath: string;
  archivePath: string;
  archiveBytes: Buffer;
  label: string;
}): ArchiveWorkerHandle {
  const timeoutMs = WORKER_TIMEOUT_MS;
  const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 7);
  const sync = new Int32Array(control);
  const worker = new Worker(
    new URL("./fixtures/flow-telemetry-db-race-worker.mjs", import.meta.url),
    {
      workerData: {
        databasePath: input.databasePath,
        archivePath: input.archivePath,
        archiveBase64: input.archiveBytes.toString("base64"),
        control,
        timeoutMs,
      },
      execArgv: ["--import", "tsx"],
    },
  );
  const exited = new Promise<number>((resolveExit) => worker.once("exit", resolveExit));
  let termination: Promise<number> | undefined;
  const terminate = (): Promise<number> => {
    termination ??= Promise.resolve(worker.terminate());
    return termination;
  };
  const handle = { label: input.label, worker, sync, timeoutMs, exited, terminate } as ArchiveWorkerHandle;
  handle.outcome = new Promise<JsonObject>((resolveOutcome) => {
    let finished = false;
    const finish = (outcome: JsonObject): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      handle.settled = outcome;
      resolveOutcome(outcome);
    };
    const timeout = setTimeout(() => {
      finish({ ok: false, harnessError: `${input.label} exceeded ${timeoutMs}ms` });
      void terminate().catch(() => undefined);
    }, timeoutMs);
    worker.once("message", (message: unknown) => finish(message as JsonObject));
    worker.once("error", (error) => finish({ ok: false, harnessError: error.message }));
    worker.once("exit", (code) => {
      if (!finished) finish({ ok: false, harnessError: `${input.label} exited ${code} without a result` });
    });
  });
  return handle;
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForWorkerCell(
  handle: ArchiveWorkerHandle,
  cell: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + WORKER_TIMEOUT_MS;
  while (Atomics.load(handle.sync, cell) !== 1) {
    if (Atomics.load(handle.sync, WORKER_CELL.completed) === 1 || handle.settled) {
      throw new Error(`${handle.label} terminated before ${label}: ${JSON.stringify(await handle.outcome)}`);
    }
    if (Date.now() >= deadline) throw new Error(`${handle.label} did not reach ${label}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 2));
  }
}

function signalWorker(handle: ArchiveWorkerHandle, cell: number): void {
  Atomics.store(handle.sync, cell, 1);
  Atomics.notify(handle.sync, cell);
}

async function stopArchiveWorkers(handles: readonly ArchiveWorkerHandle[]): Promise<void> {
  for (const handle of handles) {
    signalWorker(handle, WORKER_CELL.start);
    signalWorker(handle, WORKER_CELL.release);
  }
  const outcomes = await Promise.allSettled(handles.map((handle) => within(
    handle.outcome,
    handle.timeoutMs + WORKER_CLEANUP_TIMEOUT_MS,
    `${handle.label} outcome cleanup`,
  )));
  const terminations = await Promise.allSettled(handles.map(async (handle) => {
    await within(handle.terminate(), WORKER_CLEANUP_TIMEOUT_MS, `${handle.label} terminate`);
    await within(handle.exited, WORKER_CLEANUP_TIMEOUT_MS, `${handle.label} exit`);
  }));
  const failures = [...outcomes, ...terminations].filter(
    (settled): settled is PromiseRejectedResult => settled.status === "rejected",
  );
  if (failures.length > 0) {
    throw new AggregateError(failures.map(({ reason }) => reason), "archive worker cleanup did not terminate");
  }
}

function closeArchiveResources(resources: {
  store: TelemetryStore;
  files: StateFileDurability;
}): void {
  let firstError: unknown;
  try {
    resources.files.close();
  } catch (error) {
    firstError = error;
  }
  try {
    resources.store.close();
  } catch (error) {
    firstError ??= error;
  }
  if (firstError !== undefined) throw firstError;
}

function completeGenericArchive(
  runtime: ArchiveRuntime,
  state: TelemetryFixture,
  request: ArchiveInvocation,
): { seeded: SeededArchiveFlow; expected: BuiltArchive; archivePath: string } {
  const seeded = seedArchivableEvents(runtime.Store, state);
  const expected = expectedArchiveFromFixture(state, request);
  const resources = serviceFor(runtime, state);
  try {
    const result = resources.service.archive(request);
    expect(result).toEqual({
      archiveId: expected.archiveId,
      archivePath: archivePathFor(state, request.flowId, request.requestId),
      replayed: false,
    });
    return { seeded, expected, archivePath: result.archivePath };
  } finally {
    closeArchiveResources(resources);
  }
}

function eventShaFromRow(row: Record<string, unknown>, payloadJson: string): string {
  const payload = JSON.parse(payloadJson) as { parentSessionId?: unknown };
  return hex(canonicalJson({
    schemaVersion: "FlowEvent/v1",
    eventId: row.event_id,
    flowId: row.flow_id,
    sequenceNo: row.sequence_no,
    nodeId: row.node_id,
    attemptId: row.attempt_id,
    sessionId: row.session_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    payloadSha256: row.payload_sha256,
    previousEventSha256: row.previous_event_sha256,
    parentSessionId: payload.parentSessionId ?? null,
    traceId: row.trace_id,
    spanId: row.span_id,
    createdAt: row.created_at,
  }));
}

interface AnchorProjection {
  readonly flowId: string;
  readonly archiveId: string;
  readonly archiveSha256: string;
  readonly merkleRootSha256: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly memberCount: number;
  readonly createdAt: number;
}

function appendCanonicalAnchor(db: Database.Database, input: AnchorProjection): string {
  const previous = db.prepare("SELECT * FROM agent_events WHERE flow_id=? ORDER BY sequence_no DESC LIMIT 1")
    .get(input.flowId) as Record<string, unknown> | undefined;
  if (!previous) throw new Error("anchor test fixture requires a previous flow event");
  const eventId = hex(canonicalJson({ archiveId: input.archiveId, eventVersion: "1" }));
  const payloadJson = canonicalJson({
    schemaVersion: "TelemetryPayload/v1",
    parentSessionId: null,
    data: {
      schemaVersion: "AgentEventArchiveAnchor/v1",
      archiveId: input.archiveId,
      archiveSha256: input.archiveSha256,
      merkleRootSha256: input.merkleRootSha256,
      firstSequence: input.firstSequence,
      lastSequence: input.lastSequence,
      memberCount: input.memberCount,
    },
  });
  const event: Record<string, unknown> = {
    event_id: eventId,
    flow_id: input.flowId,
    sequence_no: Number(previous.sequence_no) + 1,
    node_id: null,
    attempt_id: null,
    session_id: null,
    event_type: "archive_anchor",
    event_version: "1",
    payload_sha256: hex(payloadJson),
    previous_event_sha256: previous.event_sha256,
    trace_id: null,
    span_id: null,
    created_at: input.createdAt,
  };
  event.event_sha256 = eventShaFromRow(event, payloadJson);
  db.prepare(`INSERT INTO agent_events
    (event_id,flow_id,sequence_no,node_id,attempt_id,session_id,event_type,event_version,payload_sha256,
     previous_event_sha256,event_sha256,trace_id,span_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.event_id,
      event.flow_id,
      event.sequence_no,
      event.node_id,
      event.attempt_id,
      event.session_id,
      event.event_type,
      event.event_version,
      event.payload_sha256,
      event.previous_event_sha256,
      event.event_sha256,
      event.trace_id,
      event.span_id,
      event.created_at,
    );
  db.prepare("INSERT INTO agent_event_payloads(event_id,payload_json,payload_sha256) VALUES (?,?,?)")
    .run(eventId, payloadJson, event.payload_sha256);
  return eventId;
}

function rewriteCanonicalAnchor(
  db: Database.Database,
  archiveId: string,
  mutateData: (data: JsonObject) => JsonObject,
): void {
  const eventId = hex(canonicalJson({ archiveId, eventVersion: "1" }));
  const event = db.prepare("SELECT * FROM agent_events WHERE event_id=?").get(eventId) as Record<string, unknown> | undefined;
  const payloadRow = db.prepare("SELECT payload_json FROM agent_event_payloads WHERE event_id=?")
    .get(eventId) as { payload_json: string } | undefined;
  if (!event || !payloadRow) throw new Error("anchor test fixture is missing its canonical event or payload");
  const successor = db.prepare("SELECT event_id FROM agent_events WHERE flow_id=? AND sequence_no>?")
    .pluck().get(event.flow_id, event.sequence_no);
  if (successor !== undefined) throw new Error("anchor rewrite requires the anchor to be the chain tail");
  const payload = JSON.parse(payloadRow.payload_json) as JsonObject;
  const data = payload.data as JsonObject;
  const payloadJson = canonicalJson({ ...payload, data: mutateData(data) });
  const payloadSha256 = hex(payloadJson);
  const changedEvent = { ...event, payload_sha256: payloadSha256 };
  const eventSha256 = eventShaFromRow(changedEvent, payloadJson);
  db.prepare("UPDATE agent_event_payloads SET payload_json=?,payload_sha256=? WHERE event_id=?")
    .run(payloadJson, payloadSha256, eventId);
  db.prepare("UPDATE agent_events SET payload_sha256=?,event_sha256=? WHERE event_id=?")
    .run(payloadSha256, eventSha256, eventId);
}

function assertExactFlowEventChain(
  events: readonly Record<string, unknown>[],
  payloads: ReadonlyMap<string, string>,
): void {
  expect(events.map(({ sequence_no }) => sequence_no))
    .toEqual(Array.from({ length: events.length }, (_unused, index) => index + 1));
  let previousEventSha256: string | null = null;
  for (const event of events) {
    const eventId = String(event.event_id);
    const payloadJson = payloads.get(eventId);
    expect(payloadJson, `payload for ${eventId}`).toBeDefined();
    expect(event.previous_event_sha256).toBe(previousEventSha256);
    expect(event.payload_sha256).toBe(hex(payloadJson!));
    expect(event.event_sha256).toBe(eventShaFromRow(event, payloadJson!));
    previousEventSha256 = String(event.event_sha256);
  }
}

function assertCompletedArchive(input: {
  state: TelemetryFixture;
  expected: BuiltArchive;
  seeded: SeededArchiveFlow;
  request: ArchiveInvocation;
  originalEvents: readonly Record<string, unknown>[];
  archivePath: string;
}): void {
  const rows = telemetryRows(input.state.databasePath);
  const archiveRows = rows.agent_event_archives!.filter(({ flow_id }) => flow_id === input.request.flowId);
  expect(archiveRows).toEqual([{
    archive_id: input.expected.archiveId,
    flow_id: input.request.flowId,
    first_sequence: input.request.firstSequence,
    last_sequence: input.request.lastSequence,
    archive_path: input.expected.relativePath,
    archive_sha256: input.expected.archiveSha256,
    merkle_root_sha256: input.expected.merkleRootSha256,
    member_count: input.expected.members.length,
    created_at: input.request.now,
  }]);
  expect(rows.agent_event_archive_members!.filter(({ flow_id }) => flow_id === input.request.flowId))
    .toEqual(input.expected.members.map((member) => ({
      flow_id: input.request.flowId,
      archive_id: input.expected.archiveId,
      event_id: member.eventId,
      payload_sha256: member.payloadSha256,
    })));
  expect(readFileSync(input.archivePath).equals(input.expected.bytes)).toBe(true);

  const events = rows.agent_events!
    .filter(({ flow_id }) => flow_id === input.request.flowId)
    .sort((left, right) => Number(left.sequence_no) - Number(right.sequence_no));
  const originalIds = new Set(input.seeded.eventIds);
  expect(events.filter(({ event_id }) => originalIds.has(String(event_id))))
    .toEqual(input.originalEvents);
  const anchors = events.filter(({ event_type }) => event_type === "archive_anchor");
  expect(anchors).toHaveLength(1);
  const anchor = anchors[0]!;
  expect(input.expected.members.map(({ eventId }) => eventId)).not.toContain(anchor.event_id);
  expect(anchor.sequence_no).toBe(events.at(-1)!.sequence_no);

  const livePayloadRows = rows.agent_event_payloads!;
  const archivedIds = new Set(input.expected.members.map(({ eventId }) => eventId));
  expect(livePayloadRows).toHaveLength(input.seeded.eventIds.length - archivedIds.size + 1);
  for (let index = 0; index < input.seeded.eventIds.length; index += 1) {
    const eventId = input.seeded.eventIds[index]!;
    const payloadRow = livePayloadRows.find(({ event_id }) => event_id === eventId);
    if (archivedIds.has(eventId)) {
      expect(payloadRow).toBeUndefined();
    } else {
      expect(payloadRow).toEqual({
        event_id: eventId,
        payload_json: input.seeded.payloads[index],
        payload_sha256: hex(input.seeded.payloads[index]!),
      });
    }
  }
  const anchorPayloadRow = livePayloadRows.find(({ event_id }) => event_id === anchor.event_id);
  expect(anchorPayloadRow).toBeDefined();
  const anchorPayloadJson = String(anchorPayloadRow!.payload_json);
  expect(anchorPayloadRow!.payload_sha256).toBe(hex(anchorPayloadJson));
  const anchorPayload = JSON.parse(anchorPayloadJson) as JsonObject;
  expect(Object.keys(anchorPayload).sort()).toEqual(["data", "parentSessionId", "schemaVersion"]);
  expect(anchorPayload).toEqual(expect.objectContaining({
    schemaVersion: "TelemetryPayload/v1",
    parentSessionId: null,
    data: expect.objectContaining({
      archiveId: input.expected.archiveId,
      archiveSha256: input.expected.archiveSha256,
      merkleRootSha256: input.expected.merkleRootSha256,
      firstSequence: input.request.firstSequence,
      lastSequence: input.request.lastSequence,
      memberCount: input.expected.members.length,
    }),
  }));

  const eventPayloads = new Map(input.seeded.eventIds.map((eventId, index) => [eventId, input.seeded.payloads[index]!]));
  eventPayloads.set(String(anchor.event_id), anchorPayloadJson);
  assertExactFlowEventChain(events, eventPayloads);
}

function eventRowsForSeed(state: TelemetryFixture, seeded: SeededArchiveFlow): Array<Record<string, unknown>> {
  const eventIds = new Set(seeded.eventIds);
  return telemetryRows(state.databasePath).agent_events!
    .filter(({ flow_id, event_id }) => flow_id === seeded.identity.flowId && eventIds.has(String(event_id)))
    .sort((left, right) => Number(left.sequence_no) - Number(right.sequence_no));
}

function assertManifestCommittedWithPayloadsIntact(input: {
  state: TelemetryFixture;
  expected: BuiltArchive;
  seeded: SeededArchiveFlow;
  request: ArchiveInvocation;
  originalEvents: readonly Record<string, unknown>[];
  archivePath: string;
}): void {
  const rows = telemetryRows(input.state.databasePath);
  expect(rows.agent_event_archives!.filter(({ flow_id }) => flow_id === input.request.flowId)).toEqual([{
    archive_id: input.expected.archiveId,
    flow_id: input.request.flowId,
    first_sequence: input.request.firstSequence,
    last_sequence: input.request.lastSequence,
    archive_path: input.expected.relativePath,
    archive_sha256: input.expected.archiveSha256,
    merkle_root_sha256: input.expected.merkleRootSha256,
    member_count: input.expected.members.length,
    created_at: input.request.now,
  }]);
  expect(rows.agent_event_archive_members!.filter(({ flow_id }) => flow_id === input.request.flowId))
    .toEqual(input.expected.members.map((member) => ({
      flow_id: input.request.flowId,
      archive_id: input.expected.archiveId,
      event_id: member.eventId,
      payload_sha256: member.payloadSha256,
    })));
  expect(readFileSync(input.archivePath).equals(input.expected.bytes)).toBe(true);
  expect(eventRowsForSeed(input.state, input.seeded)).toEqual(input.originalEvents);

  const flowEvents = rows.agent_events!.filter(({ flow_id }) => flow_id === input.request.flowId);
  const anchors = flowEvents.filter(({ event_type }) => event_type === "archive_anchor");
  expect(anchors).toHaveLength(1);
  expect(input.expected.members.map(({ eventId }) => eventId)).not.toContain(anchors[0]!.event_id);
  expect(rows.agent_event_payloads!.filter(({ event_id }) => input.seeded.eventIds.includes(String(event_id))))
    .toEqual(input.seeded.eventIds.map((eventId, index) => ({
      event_id: eventId,
      payload_json: input.seeded.payloads[index],
      payload_sha256: hex(input.seeded.payloads[index]!),
    })));
  expect(rows.agent_event_payloads).toHaveLength(input.seeded.eventIds.length + 1);
  const anchorPayloadRow = rows.agent_event_payloads!
    .find(({ event_id }) => event_id === anchors[0]!.event_id);
  expect(anchorPayloadRow).toBeDefined();
  expect(anchorPayloadRow!.payload_sha256).toBe(hex(String(anchorPayloadRow!.payload_json)));
  const orderedEvents = [...flowEvents]
    .sort((left, right) => Number(left.sequence_no) - Number(right.sequence_no));
  expect(anchors[0]!.sequence_no).toBe(orderedEvents.at(-1)!.sequence_no);
  const payloads = new Map(input.seeded.eventIds.map((eventId, index) => [eventId, input.seeded.payloads[index]!]));
  payloads.set(String(anchors[0]!.event_id), String(anchorPayloadRow!.payload_json));
  assertExactFlowEventChain(orderedEvents, payloads);
}

function assertWorkerLockIdentity(
  outcome: JsonObject,
  identity: ArchiveFlowIdentity,
  requestId: string,
): void {
  const expectedKey = hex(identity.flowId);
  const observation = outcome.lockObservation as JsonObject | undefined;
  expect(observation).toEqual({
    lockBasename: `${expectedKey}.lock`,
    lockKey: expectedKey,
  });
  const encoded = canonicalJson(observation);
  expect(encoded).not.toContain(identity.flowId);
  expect(encoded).not.toContain(requestId);
}

describe("telemetry archive pure format", () => {
  it("matches independent exact identity, request, member-set, header, path, JSONL, and Merkle oracles", async () => {
    const pure = await loadPureRuntime();
    const flowId = "flow:raw.caller-id";
    const requestId = "request:raw.caller-id";
    const createdAt = 1_800_000_000_000;
    const memberInputs = validArchiveMembers(3, flowId);
    const expected = oracleArchive({ flowId, requestId, createdAt, members: memberInputs });
    const identity = pure.deriveTelemetryArchiveIdentity({ flowId, requestId });
    expect(canonicalJson({ flowId, requestId })).toBe(
      "{\"flowId\":\"flow:raw.caller-id\",\"requestId\":\"request:raw.caller-id\"}",
    );
    expect(expected.archiveId).toBe("3704b8717ba7c1e08509ecdbeb2644e69fcd109e819dfe7b9b493c70a2a36c90");
    expect(expected.relativePath).toBe(
      "telemetry-archives/c13cc6c6a024f59f1946ffefe2b1da54709f1961b777ecfa101557cd69c3a837/" +
      "65f0b4b182ed5f2caa0888530d60848268fcdfae85c41c52030573355c0c0f54.jsonl",
    );
    expect(expected.request.membersSha256).toBe(
      "a99159cd97583716ba8b510215f9dcfda187ea548c3ef4219c6eeb20582948dc",
    );
    expect(canonicalJson(expected.request)).toBe(
      "{\"firstSequence\":1,\"flowId\":\"flow:raw.caller-id\",\"lastSequence\":3," +
      "\"membersSha256\":\"a99159cd97583716ba8b510215f9dcfda187ea548c3ef4219c6eeb20582948dc\"," +
      "\"requestId\":\"request:raw.caller-id\",\"schemaVersion\":\"AgentEventArchiveRequest/v1\"}",
    );
    expect(expected.requestSha256).toBe("9ff8924271fdb558bdab2ede2c191975efd772cfb41cd36bf25e97e5c7af7808");
    expect(expected.merkleRootSha256).toBe("d426ab4d6746f38e05a162f8178ab65b336b30c998ccf7c78eab796b1aaf7ed6");
    expect(expected.archiveSha256).toBe("702a37f8bcd27933e9d68df56077db84042624249cf3e3995e02de548f2c3480");
    expect(canonicalJson(expected.header)).toBe(
      "{\"archiveId\":\"3704b8717ba7c1e08509ecdbeb2644e69fcd109e819dfe7b9b493c70a2a36c90\"," +
      "\"createdAt\":1800000000000,\"firstSequence\":1,\"flowId\":\"flow:raw.caller-id\"," +
      "\"lastSequence\":3,\"memberCount\":3," +
      "\"merkleAlgorithm\":\"sha256-0x00-leaf-0x01-parent-duplicate-odd/v1\"," +
      "\"merkleRootSha256\":\"d426ab4d6746f38e05a162f8178ab65b336b30c998ccf7c78eab796b1aaf7ed6\"," +
      "\"requestSha256\":\"9ff8924271fdb558bdab2ede2c191975efd772cfb41cd36bf25e97e5c7af7808\"," +
      "\"schemaVersion\":\"AgentEventArchive/v1\"}",
    );
    expect(identity).toEqual(oracleArchiveIdentity(flowId, requestId));
    expect(identity.archiveId).toBe(hex(canonicalJson({ flowId, requestId })));
    expect(identity.relativePath).toBe(
      `telemetry-archives/${hex(flowId)}/${hex(identity.archiveId)}.jsonl`,
    );
    expect(identity.relativePath).not.toContain("raw.caller-id");

    const archive = pure.buildAgentEventArchive({ flowId, requestId, createdAt, members: memberInputs });
    expect(Object.keys(archive.request).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(Object.keys(archive.header).sort()).toEqual([...HEADER_KEYS].sort());
    expect(archive.members.every((member) => (
      JSON.stringify(Object.keys(member).sort()) === JSON.stringify([...MEMBER_KEYS].sort())
    ))).toBe(true);
    expect(archive.archiveId).toBe(expected.archiveId);
    expect(archive.relativePath).toBe(expected.relativePath);
    expect(archive.members).toEqual(expected.members);
    expect(archive.request).toEqual(expected.request);
    expect(archive.request.membersSha256).toBe(hex(canonicalJson(expected.members)));
    expect(archive.requestSha256).toBe(hex(canonicalJson(expected.request)));
    expect(archive.header).toEqual(expected.header);
    expect(archive.header.merkleAlgorithm).toBe(MERKLE_ALGORITHM);
    expect(archive.merkleRootSha256).toBe(expectedMerkle(expected.members));
    expect(archive.bytes.equals(expected.bytes)).toBe(true);
    expect(archive.archiveSha256).toBe(hex(expected.bytes));
    expect(() => pure.verifyAgentEventArchive(archive)).not.toThrow();
  });

  it("accepts requestId ASCII boundaries 1 and 128 and rejects empty, 129, non-ASCII, unsafe, sensitive, or non-string ids", async () => {
    const pure = await loadPureRuntime();
    for (const requestId of ["a", "r".repeat(MAX_ARCHIVE_REQUEST_ID_LENGTH)]) {
      expect(pure.deriveTelemetryArchiveIdentity({ flowId: "flow-a", requestId }))
        .toEqual(oracleArchiveIdentity("flow-a", requestId));
    }
    for (const requestId of [
      "",
      "r".repeat(MAX_ARCHIVE_REQUEST_ID_LENGTH + 1),
      "архив",
      "request/../../escape",
      "request with space",
      "ghp_abcdefghijklmno",
      1,
      null,
      undefined,
    ]) {
      expect(() => pure.deriveTelemetryArchiveIdentity({
        flowId: "flow-a",
        requestId: requestId as string,
      }), String(requestId)).toThrow(/request.?id|ascii|length|bounded|invalid/i);
    }

    for (const flowId of ["f", "f".repeat(MAX_ARCHIVE_REQUEST_ID_LENGTH)]) {
      expect(pure.deriveTelemetryArchiveIdentity({ flowId, requestId: "request-a" }))
        .toEqual(oracleArchiveIdentity(flowId, "request-a"));
    }
    for (const flowId of [
      "",
      "f".repeat(MAX_ARCHIVE_REQUEST_ID_LENGTH + 1),
      "поток",
      "flow/../../escape",
      "flow\nforged",
      "ghp_abcdefghijklmno",
    ]) {
      expect(() => pure.deriveTelemetryArchiveIdentity({ flowId, requestId: "request-a" }), flowId)
        .toThrow(/flow.?id|ascii|length|bounded|invalid|request/i);
    }
  });

  it("supports one leaf and rejects empty, gap, order, payload, or digest-invalid build inputs", async () => {
    const pure = await loadPureRuntime();
    const one = pure.buildAgentEventArchive({
      flowId: "flow-a", requestId: "one", createdAt: 1_800_000_000_000, members: validArchiveMembers(1),
    });
    expect(one.merkleRootSha256).toBe(expectedMerkle(one.members));
    expect(one.header.merkleAlgorithm).toBe(MERKLE_ALGORITHM);
    expect(() => pure.verifyAgentEventArchive(one)).not.toThrow();
    const five = pure.buildAgentEventArchive({
      flowId: "flow-a", requestId: "five", createdAt: 1_800_000_000_000, members: validArchiveMembers(5),
    });
    expect(five.merkleRootSha256).toBe(expectedMerkle(five.members));
    expect(five.header.merkleAlgorithm).toBe(MERKLE_ALGORITHM);
    expect(() => pure.verifyAgentEventArchive(five)).not.toThrow();
    expect(() => pure.buildAgentEventArchive({
      flowId: "flow-a", requestId: "empty", createdAt: 1_800_000_000_000, members: [],
    })).toThrow(/empty|member/i);
    const members = validArchiveMembers();
    for (const candidate of [
      [members[0]!, members[2]!],
      [members[1]!, members[0]!, members[2]!],
      [{ ...members[0]!, payloadJson: canonicalJson({ changed: true }) }, ...members.slice(1)],
      [{ ...members[0]!, payloadSha256: "0".repeat(64) }, ...members.slice(1)],
      [{ ...members[0]!, eventSha256: "not-a-sha256" }, ...members.slice(1)],
    ]) expect(() => pure.buildAgentEventArchive({
      flowId: "flow-a", requestId: "bad", createdAt: 1_800_000_000_000, members: candidate,
    })).toThrow(/contiguous|order|payload|hash|event|member/i);
  });

  it("rejects exhaustive structured request and raw header/member mutations, including self-consistent rehashes", async () => {
    const pure = await loadPureRuntime();
    const members = validArchiveMembers();
    const archive = pure.buildAgentEventArchive({
      flowId: "flow-a", requestId: "mutate", createdAt: 1_800_000_000_000, members,
    });
    const independent = oracleArchive({
      flowId: "flow-a", requestId: "mutate", createdAt: 1_800_000_000_000, members,
    });
    expect(archive).toEqual(independent);

    const rejection = /archive|request|header|member|schema|hash|merkle|path|bytes|canonical|invalid|mismatch|range/i;
    for (const key of REQUEST_KEYS) {
      const changedRequest = changeField(archive.request, key) as ArchiveRequest;
      expect(() => pure.verifyAgentEventArchive({ ...archive, request: changedRequest }), key).toThrow(rejection);
      const missingRequest = removeField(archive.request, key) as ArchiveRequest;
      expect(() => pure.verifyAgentEventArchive({ ...archive, request: missingRequest }), `missing ${key}`).toThrow(rejection);
    }
    expect(() => pure.verifyAgentEventArchive({
      ...archive,
      request: { ...archive.request, unexpected: true },
    })).toThrow(rejection);
    for (const requestTamper of REQUEST_TAMPER_CASES) {
      const candidate = selfConsistentRequestTamper(independent, requestTamper);
      expect(candidate.requestSha256).toBe(hex(canonicalJson(candidate.request)));
      expect(candidate.header.requestSha256).toBe(candidate.requestSha256);
      expect(candidate.archiveSha256).toBe(hex(candidate.bytes));
      expect(() => pure.verifyAgentEventArchive(candidate), requestTamper.label).toThrow(rejection);
    }

    for (const [lineIndex, keys, label] of [
      [0, HEADER_KEYS, "header"],
      [1, MEMBER_KEYS, "member"],
    ] as const) {
      for (const key of keys) {
        if (label === "header") {
          expect(() => pure.verifyAgentEventArchive({
            ...archive,
            header: changeField(archive.header, key) as ArchiveHeader,
          }), `structured ${label}.${key}`).toThrow();
        } else {
          expect(() => pure.verifyAgentEventArchive({
            ...archive,
            members: [
              changeField(archive.members[0]! as unknown as JsonObject, key) as unknown as ArchiveMember,
              ...archive.members.slice(1),
            ],
          }), `structured ${label}.${key}`).toThrow();
        }
        const changedRaw = mutateRawLine(archive, lineIndex, (line) => changeField(line, key));
        expect(() => pure.verifyAgentEventArchive({
          ...changedRaw,
          archiveSha256: hex(changedRaw.bytes),
        }), `${label}.${key}`).toThrow(rejection);
        const missingRaw = mutateRawLine(archive, lineIndex, (line) => removeField(line, key));
        expect(() => pure.verifyAgentEventArchive({
          ...missingRaw,
          archiveSha256: hex(missingRaw.bytes),
        }), `missing ${label}.${key}`).toThrow(rejection);
      }
      const extraRaw = mutateRawLine(archive, lineIndex, (line) => ({ ...line, unexpected: true }));
      expect(() => pure.verifyAgentEventArchive({
        ...extraRaw,
        archiveSha256: hex(extraRaw.bytes),
      }), `extra ${label} key`).toThrow(rejection);
    }

    for (const key of [
      "archiveId", "requestSha256", "relativePath", "archiveSha256", "merkleRootSha256",
    ] as const) {
      expect(() => pure.verifyAgentEventArchive({
        ...archive,
        [key]: changedScalar(archive[key]),
      } as BuiltArchive), `top-level ${key}`).toThrow();
    }

    for (const bytes of [
      Buffer.from(archive.bytes.toString("utf8").replaceAll("\n", "\r\n")),
      archive.bytes.subarray(0, -1),
      Buffer.concat([archive.bytes, Buffer.from("\n")]),
    ]) expect(() => pure.verifyAgentEventArchive({
      ...archive,
      bytes,
      archiveSha256: hex(bytes),
    })).toThrow(rejection);

    const forgedAlgorithm = rehashArchive(archive, {
      header: { ...archive.header, merkleAlgorithm: "sha256-undomained/v1" },
    });
    expect(() => pure.verifyAgentEventArchive(forgedAlgorithm)).toThrow(rejection);
    const forgedRequest = rehashArchive(archive, {
      request: { ...archive.request, requestId: "other-request" },
    });
    expect(() => pure.verifyAgentEventArchive(forgedRequest)).toThrow(rejection);
    const forgedMembers = [
      { ...archive.members[0]!, flowId: "flow-b" },
      ...archive.members.slice(1),
    ];
    const forgedMemberSet = rehashArchive(archive, {
      members: forgedMembers,
      request: {
        ...archive.request,
        membersSha256: hex(canonicalJson(forgedMembers)),
      },
    });
    expect(() => pure.verifyAgentEventArchive(forgedMemberSet)).toThrow(rejection);
    expect(() => pure.verifyAgentEventArchive({
      ...archive,
      relativePath: `telemetry-archives/${"0".repeat(64)}/${"1".repeat(64)}.jsonl`,
    })).toThrow(rejection);
  });
});

describe("FlowTelemetryArchiveService durability contract", () => {
  it("publishes exact bytes, commits one non-member anchor, deletes only archived payloads, and replays with zero mutation", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    const seeded = seedArchivableEvents(runtime.Store, state, 4);
    const request = archiveRequest({ requestId: "happy-path" });
    const expected = expectedArchiveFromFixture(state, request);
    const originalEvents = eventRowsForSeed(state, seeded);
    const resources = serviceFor(runtime, state);
    try {
      const result = resources.service.archive(request);
      expect(result).toEqual({
        archiveId: expected.archiveId,
        archivePath: archivePathFor(state, request.flowId, request.requestId),
        replayed: false,
      });
      assertCompletedArchive({
        state,
        expected,
        seeded,
        request,
        originalEvents,
        archivePath: result.archivePath,
      });
      for (let index = 0; index < seeded.eventIds.length; index += 1) {
        expect(resources.service.readPayload({
          flowId: seeded.identity.flowId,
          eventId: seeded.eventIds[index]!,
        })).toEqual({
          payloadJson: seeded.payloads[index],
          payloadSha256: hex(seeded.payloads[index]!),
        });
      }

      const completed = telemetryRows(state.databasePath);
      expect(resources.service.archive({ ...request, now: request.now + 1 })).toEqual({
        archiveId: expected.archiveId,
        archivePath: result.archivePath,
        replayed: true,
      });
      expect(telemetryRows(state.databasePath)).toEqual(completed);
    } finally {
      closeArchiveResources(resources);
    }
  });

  it.each([
    ["temp-file fsync", "file", FILE_FAULT_POINTS.afterFileFsync, false, false, false],
    ["immutable rename", "file", FILE_FAULT_POINTS.afterRename, true, false, true],
    ["parent-directory fsync", "file", FILE_FAULT_POINTS.afterDirectoryFsync, true, false, true],
    ["segment validation", "service", SERVICE_FAULT_POINTS.afterValidation, true, false, true],
    ["manifest commit", "service", SERVICE_FAULT_POINTS.afterManifest, true, true, true],
  ] as const)("recovers the exact %s crash boundary with bounded cleanup and idempotent retry", async (
    label,
    owner,
    faultPoint,
    finalFileExists,
    manifestCommitted,
    expectedReplay,
  ) => {
    const runtime = await loadRuntime();
    const state = fixture();
    const seeded = seedArchivableEvents(runtime.Store, state);
    const request = archiveRequest({ requestId: `crash-${owner}-${faultPoint}` });
    const expected = expectedArchiveFromFixture(state, request);
    const originalEvents = eventRowsForSeed(state, seeded);
    const before = telemetryRows(state.databasePath);
    const archivePath = archivePathFor(state, request.flowId, request.requestId);
    let faultHits = 0;
    const inject = (point: string): void => {
      if (point !== faultPoint) return;
      faultHits += 1;
      throw new Error(`injected ${label} crash`);
    };
    const crashing = serviceFor(runtime, state, owner === "file"
      ? { fileFault: inject }
      : { serviceFault: inject });
    try {
      expect(() => crashing.service.archive(request)).toThrow(`injected ${label} crash`);
      expect(faultHits).toBe(1);
    } finally {
      closeArchiveResources(crashing);
    }

    if (finalFileExists) {
      expect(lstatSync(archivePath).isFile()).toBe(true);
      expect(readFileSync(archivePath).equals(expected.bytes)).toBe(true);
      expect(archiveDataFiles(state)).toEqual([archivePath]);
    } else {
      expect(existsSync(archivePath)).toBe(false);
      expect(archiveDataFiles(state)).toEqual([]);
    }
    if (manifestCommitted) {
      assertManifestCommittedWithPayloadsIntact({
        state,
        expected,
        seeded,
        request,
        originalEvents,
        archivePath,
      });
    } else {
      expect(telemetryRows(state.databasePath)).toEqual(before);
    }

    const recovering = serviceFor(runtime, state);
    try {
      const recovered = recovering.service.archive(request);
      expect(recovered).toEqual({
        archiveId: expected.archiveId,
        archivePath,
        replayed: expectedReplay,
      });
      assertCompletedArchive({ state, expected, seeded, request, originalEvents, archivePath });
      const afterRecovery = telemetryRows(state.databasePath);
      expect(recovering.service.archive({ ...request, now: request.now + 1 })).toEqual({
        archiveId: expected.archiveId,
        archivePath,
        replayed: true,
      });
      expect(telemetryRows(state.databasePath)).toEqual(afterRecovery);
      expect(archiveDataFiles(state)).toEqual([archivePath]);
    } finally {
      closeArchiveResources(recovering);
    }
  });

  it("uses the terminal graph_flows.updated_at value as a manifest CAS and adopts the intact orphan on retry", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    const seeded = seedArchivableEvents(runtime.Store, state);
    const request = archiveRequest({ requestId: "terminal-updated-at-cas" });
    const expected = expectedArchiveFromFixture(state, request);
    const originalEvents = eventRowsForSeed(state, seeded);
    const before = telemetryRows(state.databasePath);
    const archivePath = archivePathFor(state, request.flowId, request.requestId);
    let mutationCount = 0;
    const racing = serviceFor(runtime, state, {
      serviceFault: (point) => {
        if (point !== SERVICE_FAULT_POINTS.afterValidation) return;
        mutationCount += 1;
        const db = new Database(state.databasePath);
        try {
          const changed = db.prepare("UPDATE graph_flows SET updated_at=updated_at+1 WHERE flow_id=?")
            .run(request.flowId);
          expect(changed.changes).toBe(1);
        } finally {
          db.close();
        }
      },
    });
    try {
      expect(() => racing.service.archive(request)).toThrow(/cas|stale|changed|updated_at|terminal/i);
      expect(mutationCount).toBe(1);
    } finally {
      closeArchiveResources(racing);
    }

    const afterRace = telemetryRows(state.databasePath);
    for (const [table, rows] of Object.entries(before)) {
      if (table !== "graph_flows") expect(afterRace[table]).toEqual(rows);
    }
    const beforeFlow = before.graph_flows!.find(({ flow_id }) => flow_id === request.flowId)!;
    const afterFlow = afterRace.graph_flows!.find(({ flow_id }) => flow_id === request.flowId)!;
    expect(afterFlow.updated_at).toBe(Number(beforeFlow.updated_at) + 1);
    expect({ ...afterFlow, updated_at: beforeFlow.updated_at }).toEqual(beforeFlow);
    assertValidGraphLifecycle(state.databasePath);
    expect(readFileSync(archivePath).equals(expected.bytes)).toBe(true);

    const recovering = serviceFor(runtime, state);
    try {
      expect(recovering.service.archive(request)).toEqual({
        archiveId: expected.archiveId,
        archivePath,
        replayed: true,
      });
      assertCompletedArchive({ state, expected, seeded, request, originalEvents, archivePath });
    } finally {
      closeArchiveResources(recovering);
    }
  });

  it.each(ARCHIVE_FILE_TAMPER_CASES.map((tamper, index) => [tamper.label, index, tamper] as const))(
    "rejects self-consistent real-orphan tamper %s without DB mutation",
    async (_label, index, tamper) => {
      const runtime = await loadRuntime();
      const state = fixture();
      seedArchivableEvents(runtime.Store, state, 5);
      const request = archiveRequest({ requestId: `orphan-tamper-${index}`, lastSequence: 5 });
      const expected = expectedArchiveFromFixture(state, request);
      const archivePath = archivePathFor(state, request.flowId, request.requestId);
      const before = telemetryRows(state.databasePath);
      let faultHits = 0;
      const publishing = serviceFor(runtime, state, {
        fileFault: (point) => {
          if (point !== FILE_FAULT_POINTS.afterDirectoryFsync) return;
          faultHits += 1;
          throw new Error("orphan ready");
        },
      });
      try {
        expect(() => publishing.service.archive(request)).toThrow(/orphan ready/i);
      } finally {
        closeArchiveResources(publishing);
      }
      expect(faultHits).toBe(1);
      expect(telemetryRows(state.databasePath)).toEqual(before);
      expect(readFileSync(archivePath).equals(expected.bytes)).toBe(true);
      expect(expected.request.membersSha256).toBe(hex(canonicalJson(expected.members)));
      expect(expected.requestSha256).toBe(hex(canonicalJson(expected.request)));
      expect(expected.merkleRootSha256).toBe(expectedMerkle(expected.members));
      expect(expected.archiveSha256).toBe(hex(expected.bytes));

      const candidate = selfConsistentArchiveFileTamper(expected, tamper);
      const candidateLines = candidate.bytes.toString("utf8").slice(0, -1).split("\n");
      expect(candidate.bytes.equals(expected.bytes)).toBe(false);
      expect(candidate.archiveSha256).not.toBe(expected.archiveSha256);
      expect(candidate.bytes.at(-1)).toBe(10);
      expect(candidateLines.map((line) => canonicalJson(JSON.parse(line))))
        .toEqual(candidateLines);
      expect(candidateLines.map((line) => JSON.parse(line)))
        .toEqual([candidate.header, ...candidate.members]);
      expect(candidate.request.membersSha256).toBe(hex(canonicalJson(candidate.members)));
      if (!(tamper.scope === "header" && tamper.key === "requestSha256")) {
        expect(candidate.requestSha256).toBe(hex(canonicalJson(candidate.request)));
        expect(candidate.header.requestSha256).toBe(candidate.requestSha256);
      }
      if (!(tamper.scope === "header" && tamper.key === "merkleRootSha256")) {
        expect(candidate.merkleRootSha256).toBe(expectedMerkle(candidate.members));
        expect(candidate.header.merkleRootSha256).toBe(candidate.merkleRootSha256);
      }
      expect(candidate.archiveSha256).toBe(hex(candidate.bytes));
      writeFileSync(archivePath, candidate.bytes);
      const beforeRetry = telemetryRows(state.databasePath);

      const retrying = serviceFor(runtime, state);
      try {
        expect(() => retrying.service.archive(request), tamper.label)
          .toThrow(/archive|orphan|request|header|member|schema|hash|merkle|identity|range|canonical|mismatch/i);
        expect(telemetryRows(state.databasePath)).toEqual(beforeRetry);
        expect(readFileSync(archivePath).equals(candidate.bytes)).toBe(true);
      } finally {
        closeArchiveResources(retrying);
      }
    },
  );

  it("rejects and preserves a truncated pre-manifest orphan", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    seedArchivableEvents(runtime.Store, state);
    const request = archiveRequest({ requestId: "truncated-orphan" });
    const expected = expectedArchiveFromFixture(state, request);
    const archivePath = archivePathFor(state, request.flowId, request.requestId);
    const before = telemetryRows(state.databasePath);
    const publishing = serviceFor(runtime, state, {
      fileFault: (point) => {
        if (point === FILE_FAULT_POINTS.afterDirectoryFsync) throw new Error("published orphan");
      },
    });
    try {
      expect(() => publishing.service.archive(request)).toThrow(/published orphan/i);
    } finally {
      closeArchiveResources(publishing);
    }
    expect(telemetryRows(state.databasePath)).toEqual(before);
    const truncated = expected.bytes.subarray(0, expected.bytes.length - 1);
    writeFileSync(archivePath, truncated);

    const retrying = serviceFor(runtime, state);
    try {
      expect(() => retrying.service.archive(request)).toThrow(/archive|orphan|corrupt|hash|segment|truncated|canonical/i);
      expect(telemetryRows(state.databasePath)).toEqual(before);
      expect(readFileSync(archivePath).equals(truncated)).toBe(true);
    } finally {
      closeArchiveResources(retrying);
    }
  });

  it("never deletes payloads or repairs bytes when a committed segment is corrupt", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    const seeded = seedArchivableEvents(runtime.Store, state);
    const request = archiveRequest({ requestId: "committed-corrupt" });
    const expected = expectedArchiveFromFixture(state, request);
    const originalEvents = eventRowsForSeed(state, seeded);
    const archivePath = archivePathFor(state, request.flowId, request.requestId);
    const committing = serviceFor(runtime, state, {
      serviceFault: (point) => {
        if (point === SERVICE_FAULT_POINTS.afterManifest) throw new Error("manifest committed");
      },
    });
    try {
      expect(() => committing.service.archive(request)).toThrow(/manifest committed/i);
    } finally {
      closeArchiveResources(committing);
    }
    assertManifestCommittedWithPayloadsIntact({
      state,
      expected,
      seeded,
      request,
      originalEvents,
      archivePath,
    });
    const beforeCorruptRetry = telemetryRows(state.databasePath);
    const corrupt = Buffer.from("truncated\n");
    writeFileSync(archivePath, corrupt);

    const retrying = serviceFor(runtime, state);
    try {
      expect(() => retrying.service.archive(request)).toThrow(/archive|corrupt|hash|segment|truncated|canonical/i);
      expect(() => retrying.service.readPayload({
        flowId: request.flowId,
        eventId: seeded.eventIds[0]!,
      })).toThrow(/archive|corrupt|hash|segment|truncated|canonical/i);
      expect(telemetryRows(state.databasePath)).toEqual(beforeCorruptRetry);
      expect(readFileSync(archivePath).equals(corrupt)).toBe(true);
    } finally {
      closeArchiveResources(retrying);
    }
  });

  it("enforces request replay, changed-body conflict, non-overlap, overlap rejection, and anchor exclusion", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    seedArchivableEvents(runtime.Store, state, 6);
    const first = archiveRequest({ requestId: "range-first", firstSequence: 1, lastSequence: 3 });
    const overlapping = archiveRequest({ requestId: "range-overlap", firstSequence: 3, lastSequence: 4 });
    const later = archiveRequest({ requestId: "range-later", firstSequence: 4, lastSequence: 6 });
    const resources = serviceFor(runtime, state);
    try {
      const firstResult = resources.service.archive(first);
      expect(firstResult.replayed).toBe(false);
      const afterFirst = telemetryRows(state.databasePath);
      expect(resources.service.archive({ ...first, now: first.now + 1 })).toEqual({
        archiveId: firstResult.archiveId,
        archivePath: firstResult.archivePath,
        replayed: true,
      });
      expect(telemetryRows(state.databasePath)).toEqual(afterFirst);
      expect(() => resources.service.archive({ ...first, lastSequence: 2 }))
        .toThrow(/request|identity|conflict|immutable|range/i);
      expect(() => resources.service.archive(overlapping)).toThrow(/overlap|range|archive/i);
      expect(telemetryRows(state.databasePath)).toEqual(afterFirst);

      expect(resources.service.archive(later)).toEqual(expect.objectContaining({ replayed: false }));
      const afterLater = telemetryRows(state.databasePath);
      expect(afterLater.agent_event_archives).toHaveLength(2);
      expect(afterLater.agent_event_archive_members).toHaveLength(6);
      expect(afterLater.agent_events!.filter(({ event_type }) => event_type === "archive_anchor")).toHaveLength(2);
      expect(() => resources.service.archive(archiveRequest({
        requestId: "anchor-is-not-member",
        firstSequence: 7,
        lastSequence: 7,
      }))).toThrow(/anchor|member|range|archive|eligible|contiguous/i);
      expect(telemetryRows(state.databasePath)).toEqual(afterLater);
    } finally {
      closeArchiveResources(resources);
    }
  });

  it("rejects a symlinked archive root without DB or external-directory mutation", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    seedArchivableEvents(runtime.Store, state);
    const archiveRoot = join(dirname(state.databasePath), "telemetry-archives");
    const external = join(state.root, "external-archive-root");
    mkdirSync(external);
    rmSync(archiveRoot, { recursive: true, force: true });
    symlinkSync(external, archiveRoot);
    const before = telemetryRows(state.databasePath);
    let resources: ReturnType<typeof serviceFor> | undefined;
    try {
      expect(() => {
        resources = serviceFor(runtime, state);
        resources.service.archive(archiveRequest({ requestId: "root-symlink" }));
      }).toThrow(/symlink|confined|path|root|no.?follow/i);
      expect(telemetryRows(state.databasePath)).toEqual(before);
      expect(readdirSync(external)).toEqual([]);
    } finally {
      if (resources) closeArchiveResources(resources);
    }
  });

  it("rejects a byte-identical symlink substitution after validation and never follows the target", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    seedArchivableEvents(runtime.Store, state);
    const request = archiveRequest({ requestId: "validation-symlink" });
    const expected = expectedArchiveFromFixture(state, request);
    const archivePath = archivePathFor(state, request.flowId, request.requestId);
    const outsideTarget = join(state.root, "byte-identical-validation-target.jsonl");
    const before = telemetryRows(state.databasePath);
    let substituted = false;
    let outsideBytes = Buffer.alloc(0);
    const resources = serviceFor(runtime, state, {
      serviceFault: (point) => {
        if (point !== SERVICE_FAULT_POINTS.afterValidation) return;
        outsideBytes = readFileSync(archivePath);
        expect(outsideBytes.equals(expected.bytes)).toBe(true);
        writeFileSync(outsideTarget, outsideBytes);
        rmSync(archivePath, { force: true });
        symlinkSync(outsideTarget, archivePath);
        substituted = true;
      },
    });
    try {
      expect(() => resources.service.archive(request))
        .toThrow(/symlink|no.?follow|identity|changed|confined|path|archive|regular/i);
      expect(substituted).toBe(true);
      expect(telemetryRows(state.databasePath)).toEqual(before);
      expect(readFileSync(outsideTarget).equals(outsideBytes)).toBe(true);
    } finally {
      closeArchiveResources(resources);
    }
  });

  it("rejects a byte-identical post-manifest symlink on retry and archived reads without deleting payloads", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    const seeded = seedArchivableEvents(runtime.Store, state);
    const request = archiveRequest({ requestId: "manifest-symlink" });
    const expected = expectedArchiveFromFixture(state, request);
    const originalEvents = eventRowsForSeed(state, seeded);
    const archivePath = archivePathFor(state, request.flowId, request.requestId);
    const committing = serviceFor(runtime, state, {
      serviceFault: (point) => {
        if (point === SERVICE_FAULT_POINTS.afterManifest) throw new Error("post-manifest crash");
      },
    });
    try {
      expect(() => committing.service.archive(request)).toThrow(/post-manifest crash/i);
    } finally {
      closeArchiveResources(committing);
    }
    assertManifestCommittedWithPayloadsIntact({
      state,
      expected,
      seeded,
      request,
      originalEvents,
      archivePath,
    });
    const committed = telemetryRows(state.databasePath);
    const outsideTarget = join(state.root, "byte-identical-manifest-target.jsonl");
    writeFileSync(outsideTarget, expected.bytes);
    rmSync(archivePath, { force: true });
    symlinkSync(outsideTarget, archivePath);

    const retrying = serviceFor(runtime, state);
    try {
      expect(() => retrying.service.archive(request))
        .toThrow(/symlink|no.?follow|identity|changed|confined|path|archive|regular/i);
      expect(() => retrying.service.readPayload({
        flowId: request.flowId,
        eventId: seeded.eventIds[0]!,
      })).toThrow(/symlink|no.?follow|identity|changed|confined|path|archive|regular/i);
      expect(telemetryRows(state.databasePath)).toEqual(committed);
      expect(readFileSync(outsideTarget).equals(expected.bytes)).toBe(true);
    } finally {
      closeArchiveResources(retrying);
    }
  });

  it("serializes one flow across different requestIds with one exact sha256(flowId) lock", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    seedArchivableEvents(runtime.Store, state, 6);
    const firstRequest = archiveRequest({ requestId: "lock-first", firstSequence: 1, lastSequence: 3 });
    const secondRequest = archiveRequest({ requestId: "lock-second", firstSequence: 4, lastSequence: 6 });
    const handles: ArchiveWorkerHandle[] = [];
    try {
      const first = startArchiveWorker({
        databasePath: state.databasePath,
        archiveInput: firstRequest,
        label: "same-flow-first",
        holdAfterAcquire: true,
      });
      handles.push(first);
      await waitForWorkerCell(first, WORKER_CELL.ready, "ready");
      signalWorker(first, WORKER_CELL.start);
      await waitForWorkerCell(first, WORKER_CELL.acquired, "flow lock acquired");

      const second = startArchiveWorker({
        databasePath: state.databasePath,
        archiveInput: secondRequest,
        label: "same-flow-second",
      });
      handles.push(second);
      await waitForWorkerCell(second, WORKER_CELL.ready, "ready");
      signalWorker(second, WORKER_CELL.start);
      await waitForWorkerCell(second, WORKER_CELL.beforeAcquire, "before lock acquire");
      await waitForWorkerCell(second, WORKER_CELL.contended, "same-flow contention");
      expect(Atomics.load(second.sync, WORKER_CELL.acquired)).toBe(0);
      expect(telemetryRows(state.databasePath).agent_event_archives).toEqual([]);

      signalWorker(first, WORKER_CELL.release);
      await waitForWorkerCell(second, WORKER_CELL.acquired, "lock after release");
      const [firstOutcome, secondOutcome] = await Promise.all([first.outcome, second.outcome]);
      expect(firstOutcome).toEqual(expect.objectContaining({
        ok: true,
        result: expect.objectContaining({ replayed: false }),
      }));
      expect(secondOutcome).toEqual(expect.objectContaining({
        ok: true,
        result: expect.objectContaining({ replayed: false }),
      }));
      assertWorkerLockIdentity(firstOutcome, DEFAULT_ARCHIVE_FLOW, firstRequest.requestId);
      assertWorkerLockIdentity(secondOutcome, DEFAULT_ARCHIVE_FLOW, secondRequest.requestId);
      expect(firstOutcome.lockObservation).toEqual(secondOutcome.lockObservation);
    } finally {
      await stopArchiveWorkers(handles);
    }
    const rows = telemetryRows(state.databasePath);
    expect(rows.agent_event_archives).toHaveLength(2);
    expect(rows.agent_event_archive_members).toHaveLength(6);
    expect(rows.agent_events!.filter(({ event_type }) => event_type === "archive_anchor")).toHaveLength(2);
  });

  it("lets different flows with the same requestId proceed under independent hashed locks", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    seedArchivableEvents(runtime.Store, state, 3, DEFAULT_ARCHIVE_FLOW);
    seedArchivableEvents(runtime.Store, state, 3, SECOND_ARCHIVE_FLOW);
    const sharedRequestId = "shared-request-id";
    const firstRequest = archiveRequest({ flowId: DEFAULT_ARCHIVE_FLOW.flowId, requestId: sharedRequestId });
    const secondRequest = archiveRequest({ flowId: SECOND_ARCHIVE_FLOW.flowId, requestId: sharedRequestId });
    const handles: ArchiveWorkerHandle[] = [];
    try {
      const first = startArchiveWorker({
        databasePath: state.databasePath,
        archiveInput: firstRequest,
        label: "flow-b-held",
        holdAfterAcquire: true,
      });
      handles.push(first);
      await waitForWorkerCell(first, WORKER_CELL.ready, "ready");
      signalWorker(first, WORKER_CELL.start);
      await waitForWorkerCell(first, WORKER_CELL.acquired, "flow-b lock acquired");

      const second = startArchiveWorker({
        databasePath: state.databasePath,
        archiveInput: secondRequest,
        label: "flow-a-independent",
      });
      handles.push(second);
      await waitForWorkerCell(second, WORKER_CELL.ready, "ready");
      signalWorker(second, WORKER_CELL.start);
      await waitForWorkerCell(second, WORKER_CELL.acquired, "flow-a lock acquired independently");
      expect(Atomics.load(second.sync, WORKER_CELL.contended)).toBe(0);
      const secondOutcome = await second.outcome;
      expect(secondOutcome).toEqual(expect.objectContaining({ ok: true }));
      expect(Atomics.load(first.sync, WORKER_CELL.completed)).toBe(0);
      assertWorkerLockIdentity(secondOutcome, SECOND_ARCHIVE_FLOW, sharedRequestId);

      signalWorker(first, WORKER_CELL.release);
      const firstOutcome = await first.outcome;
      expect(firstOutcome).toEqual(expect.objectContaining({ ok: true }));
      assertWorkerLockIdentity(firstOutcome, DEFAULT_ARCHIVE_FLOW, sharedRequestId);
      expect(firstOutcome.lockObservation).not.toEqual(secondOutcome.lockObservation);
    } finally {
      await stopArchiveWorkers(handles);
    }
    const rows = telemetryRows(state.databasePath);
    expect(rows.agent_event_archives).toHaveLength(2);
    expect(rows.agent_event_archive_members).toHaveLength(6);
    expect(rows.agent_events!.filter(({ event_type }) => event_type === "archive_anchor")).toHaveLength(2);
  });

  it("releases the flow lock after abrupt worker termination and permits a bounded successor", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    seedArchivableEvents(runtime.Store, state);
    const request = archiveRequest({ requestId: "crash-release" });
    const before = telemetryRows(state.databasePath);
    const handles: ArchiveWorkerHandle[] = [];
    try {
      const crashing = startArchiveWorker({
        databasePath: state.databasePath,
        archiveInput: request,
        label: "crashing-lock-owner",
        holdAfterAcquire: true,
      });
      handles.push(crashing);
      await waitForWorkerCell(crashing, WORKER_CELL.ready, "ready");
      signalWorker(crashing, WORKER_CELL.start);
      await waitForWorkerCell(crashing, WORKER_CELL.acquired, "lock acquired");
      await within(crashing.terminate(), WORKER_CLEANUP_TIMEOUT_MS, "crashing owner terminate");
      await within(crashing.exited, WORKER_CLEANUP_TIMEOUT_MS, "crashing owner exit");
      expect(await crashing.outcome).toEqual(expect.objectContaining({
        ok: false,
        harnessError: expect.stringMatching(/exited .* without a result/i),
      }));
      expect(telemetryRows(state.databasePath)).toEqual(before);

      const successor = startArchiveWorker({
        databasePath: state.databasePath,
        archiveInput: request,
        label: "post-crash-successor",
      });
      handles.push(successor);
      await waitForWorkerCell(successor, WORKER_CELL.ready, "ready");
      signalWorker(successor, WORKER_CELL.start);
      await waitForWorkerCell(successor, WORKER_CELL.acquired, "released lock acquired");
      const successorOutcome = await successor.outcome;
      expect(successorOutcome).toEqual(expect.objectContaining({
        ok: true,
        result: expect.objectContaining({ replayed: false }),
      }));
      assertWorkerLockIdentity(successorOutcome, DEFAULT_ARCHIVE_FLOW, request.requestId);
    } finally {
      await stopArchiveWorkers(handles);
    }
  });

  it("bounds cleanup of a hung lock owner and proves crash-release with a successor", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    seedArchivableEvents(runtime.Store, state);
    const request = archiveRequest({ requestId: "hung-owner-release" });
    const before = telemetryRows(state.databasePath);
    const hung = startArchiveWorker({
      databasePath: state.databasePath,
      archiveInput: request,
      label: "hung-lock-owner",
      hangAfterAcquire: true,
      timeoutMs: 3_000,
    });
    let hungStopped = false;
    try {
      await waitForWorkerCell(hung, WORKER_CELL.ready, "ready");
      signalWorker(hung, WORKER_CELL.start);
      await waitForWorkerCell(hung, WORKER_CELL.acquired, "hung lock acquired");
      const cleanupStarted = Date.now();
      await stopArchiveWorkers([hung]);
      hungStopped = true;
      expect(Date.now() - cleanupStarted).toBeLessThan(hung.timeoutMs + 2 * WORKER_CLEANUP_TIMEOUT_MS);
      expect(hung.settled).toEqual(expect.objectContaining({
        ok: false,
        harnessError: expect.stringMatching(/exceeded 3000ms/i),
      }));
    } finally {
      if (!hungStopped) await stopArchiveWorkers([hung]);
    }
    expect(telemetryRows(state.databasePath)).toEqual(before);

    const successor = startArchiveWorker({
      databasePath: state.databasePath,
      archiveInput: request,
      label: "post-hang-successor",
    });
    try {
      await waitForWorkerCell(successor, WORKER_CELL.ready, "ready");
      signalWorker(successor, WORKER_CELL.start);
      await waitForWorkerCell(successor, WORKER_CELL.acquired, "post-hang lock acquired");
      const outcome = await successor.outcome;
      expect(outcome).toEqual(expect.objectContaining({ ok: true }));
      assertWorkerLockIdentity(outcome, DEFAULT_ARCHIVE_FLOW, request.requestId);
    } finally {
      await stopArchiveWorkers([successor]);
    }
  });
});

describe("flow telemetry archive/store integrity correction regressions", () => {
  it("rejects a direct manifest commit when no pinned archive file authority exists", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    const request = archiveRequest({ requestId: "direct-commit-without-file" });
    seedArchivableEvents(runtime.Store, state);
    const expected = expectedArchiveFromFixture(state, request);
    const store = new runtime.Store(state.databasePath);
    try {
      const prepared = store.prepareArchive(request);
      const rowsBefore = telemetryRows(state.databasePath);
      const databaseFilesBefore = stateDatabaseFileSnapshot(state.databasePath);
      const filesBefore = archiveFileSnapshot(state);

      expect(() => store.commitArchiveManifest({
        prepared,
        archive: {
          archiveId: expected.archiveId,
          flowId: expected.header.flowId,
          requestSha256: expected.requestSha256,
          relativePath: expected.relativePath,
          archiveSha256: expected.archiveSha256,
          merkleRootSha256: expected.merkleRootSha256,
          createdAt: expected.header.createdAt,
          firstSequence: expected.header.firstSequence,
          lastSequence: expected.header.lastSequence,
          members: prepared.members,
        },
      })).toThrow(/archive.*(authority|capability|pinned|file)|not issued/i);
      expect(stateDatabaseFileSnapshot(state.databasePath)).toEqual(databaseFilesBefore);
      expect(telemetryRows(state.databasePath)).toEqual(rowsBefore);
      expect(archiveFileSnapshot(state)).toEqual(filesBefore);
    } finally {
      store.close();
    }
  });

  it("rejects direct payload deletion after the committed archive file is replaced", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    const request = archiveRequest({ requestId: "direct-delete-replaced-file" });
    seedArchivableEvents(runtime.Store, state);
    const expected = expectedArchiveFromFixture(state, request);
    const committing = serviceFor(runtime, state, {
      serviceFault: (point) => {
        if (point === SERVICE_FAULT_POINTS.afterManifest) throw new Error("manifest committed");
      },
    });
    try {
      expect(() => committing.service.archive(request)).toThrow(/manifest committed/i);
    } finally {
      closeArchiveResources(committing);
    }

    const archivePath = archivePathFor(state, request.flowId, request.requestId);
    rmSync(archivePath);
    writeFileSync(archivePath, "replaced archive bytes\n");
    const store = new runtime.Store(state.databasePath);
    try {
      const rowsBefore = telemetryRows(state.databasePath);
      const databaseFilesBefore = stateDatabaseFileSnapshot(state.databasePath);
      const filesBefore = archiveFileSnapshot(state);
      const members = expected.members.map((member) => ({
        eventId: member.eventId,
        sequenceNo: member.sequenceNo,
        eventSha256: member.eventSha256,
        payloadSha256: member.payloadSha256,
        payloadJson: member.payloadJson,
      }));

      expect(() => store.deleteArchivedPayloads({
        archiveId: expected.archiveId,
        flowId: expected.header.flowId,
        archiveSha256: expected.archiveSha256,
        merkleRootSha256: expected.merkleRootSha256,
        members,
      })).toThrow(/archive.*(authority|capability|pinned|file)|not issued|changed/i);
      expect(stateDatabaseFileSnapshot(state.databasePath)).toEqual(databaseFilesBefore);
      expect(telemetryRows(state.databasePath)).toEqual(rowsBefore);
      expect(archiveFileSnapshot(state)).toEqual(filesBefore);
    } finally {
      store.close();
    }
  });

  it("binds archive capabilities to the exact store, body, phase, and one-time use", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    seedArchivableEvents(runtime.Store, state);
    const request = archiveRequest({ requestId: "capability-body-and-reuse" });
    const expected = expectedArchiveFromFixture(state, request);
    const store = new runtime.Store(state.databasePath);
    const files = new runtime.Files({ stateRoot: dirname(state.databasePath) });
    const authority = runtime.createAuthority();
    store.bindArchiveAuthority(authority.store);
    const prepared = store.prepareArchive(request);
    const archive = {
      archiveId: expected.archiveId,
      flowId: expected.header.flowId,
      requestSha256: expected.requestSha256,
      relativePath: expected.relativePath,
      archiveSha256: expected.archiveSha256,
      merkleRootSha256: expected.merkleRootSha256,
      createdAt: expected.header.createdAt,
      firstSequence: expected.header.firstSequence,
      lastSequence: expected.header.lastSequence,
      members: prepared.members,
    };
    const deletion = {
      archiveId: expected.archiveId,
      flowId: expected.header.flowId,
      archiveSha256: expected.archiveSha256,
      merkleRootSha256: expected.merkleRootSha256,
      members: prepared.members,
    };
    const commit = { prepared, archive };
    const rowsBeforeForgery = telemetryRows(state.databasePath);
    const forgedFile = Object.freeze({
      absolutePath: archivePathFor(state, request.flowId, request.requestId),
      read: () => Buffer.from(expected.bytes),
      assertCurrent: () => undefined,
      close: () => undefined,
    });
    expect(() => authority.service.issueCommitCapability({
      proof: authorityFileProof(expected, forgedFile),
      commit,
      deletion,
    })).toThrow(/pinned state file.*not issued|StateFileDurability|authentic/i);
    expect(existsSync(forgedFile.absolutePath)).toBe(false);
    expect(telemetryRows(state.databasePath)).toEqual(rowsBeforeForgery);

    const publication = files.publishImmutable({ relativePath: expected.relativePath, bytes: expected.bytes });
    try {
      const before = telemetryRows(state.databasePath);
      const capability = authority.service.issueCommitCapability({
        proof: authorityFileProof(expected, publication.file),
        commit,
        deletion,
      });
      expect(() => store.commitArchiveManifest({
        capability: { ...capability },
        ...commit,
      })).toThrow(/capability.*not issued|not issued.*store/i);
      expect(telemetryRows(state.databasePath)).toEqual(before);

      expect(() => store.commitArchiveManifest({
        capability,
        prepared,
        archive: { ...archive, firstSequence: archive.firstSequence + 1 },
      })).toThrow(/capability.*exact body|authorize.*body/i);
      expect(telemetryRows(state.databasePath)).toEqual(before);

      const committed = store.commitArchiveManifest({ capability, ...commit }) as {
        replayed: boolean;
        deletionCapability: ArchiveDeletionCapability;
      };
      expect(committed.replayed).toBe(false);
      expect(() => store.commitArchiveManifest({ capability, ...commit }))
        .toThrow(/capability.*already consumed|already consumed.*capability/i);

      const rowsAfterCommit = telemetryRows(state.databasePath);
      expect(() => store.deleteArchivedPayloads({
        capability: { ...committed.deletionCapability },
        ...deletion,
      })).toThrow(/deletion capability.*not issued|not issued.*store/i);
      expect(() => store.deleteArchivedPayloads({
        capability: committed.deletionCapability,
        ...deletion,
        flowId: "flow-other",
      })).toThrow(/capability.*exact body|authorize.*body/i);
      expect(telemetryRows(state.databasePath)).toEqual(rowsAfterCommit);

      expect(store.deleteArchivedPayloads({ capability: committed.deletionCapability, ...deletion }))
        .toEqual({ replayed: false });
      expect(() => store.deleteArchivedPayloads({ capability: committed.deletionCapability, ...deletion }))
        .toThrow(/capability.*already consumed|already consumed.*capability/i);
    } finally {
      publication.file.close();
      files.close();
      store.close();
    }
  });

  it("verifies the archive only after a contended SQLite write lock is acquired", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    seedArchivableEvents(runtime.Store, state);
    const request = archiveRequest({ requestId: "commit-authority-after-db-lock" });
    const expected = expectedArchiveFromFixture(state, request);
    let race: ArchiveWorkerHandle | undefined;
    const store = new runtime.Store(state.databasePath, {
      faultInjector: (point) => {
        if (point === "before_archive_commit_transaction" && race) {
          signalWorker(race, WORKER_CELL.beforeAcquire);
        }
      },
    });
    const files = new runtime.Files({ stateRoot: dirname(state.databasePath) });
    const authority = runtime.createAuthority();
    store.bindArchiveAuthority(authority.store);
    const prepared = store.prepareArchive(request);
    const archive = {
      archiveId: expected.archiveId,
      flowId: expected.header.flowId,
      requestSha256: expected.requestSha256,
      relativePath: expected.relativePath,
      archiveSha256: expected.archiveSha256,
      merkleRootSha256: expected.merkleRootSha256,
      createdAt: expected.header.createdAt,
      firstSequence: expected.header.firstSequence,
      lastSequence: expected.header.lastSequence,
      members: prepared.members,
    };
    const deletion = {
      archiveId: expected.archiveId,
      flowId: expected.header.flowId,
      archiveSha256: expected.archiveSha256,
      merkleRootSha256: expected.merkleRootSha256,
      members: prepared.members,
    };
    const commit = { prepared, archive };
    const publication = files.publishImmutable({ relativePath: expected.relativePath, bytes: expected.bytes });
    race = startDatabaseRaceWorker({
      databasePath: state.databasePath,
      archivePath: publication.file.absolutePath,
      archiveBytes: expected.bytes,
      label: "commit-authority-db-lock-race",
    });
    try {
      const capability = authority.service.issueCommitCapability({
        proof: authorityFileProof(expected, publication.file),
        commit,
        deletion,
      });
      const before = telemetryRows(state.databasePath);
      await waitForWorkerCell(race, WORKER_CELL.ready, "database race ready");
      signalWorker(race, WORKER_CELL.start);

      expect(() => store.commitArchiveManifest({ capability, ...commit }))
        .toThrow(/identity changed|pinned.*changed|file.*changed|descriptor.*regular|no-follow/i);
      expect(await race.outcome).toEqual({ ok: true });
      expect(telemetryRows(state.databasePath)).toEqual(before);
    } finally {
      await stopArchiveWorkers(race ? [race] : []);
      publication.file.close();
      files.close();
      store.close();
    }
  });

  it("rolls back payload deletion when the archive path changes before transaction commit", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    seedArchivableEvents(runtime.Store, state);
    const request = archiveRequest({ requestId: "delete-authority-final-reverify" });
    const expected = expectedArchiveFromFixture(state, request);
    let replaceArchive = false;
    let archivePath: string | undefined;
    const store = new runtime.Store(state.databasePath, {
      faultInjector: (point) => {
        if (!replaceArchive || point !== "after_archive_payload_delete_before_file_reverify" || !archivePath) return;
        replaceArchive = false;
        rmSync(archivePath);
        writeFileSync(archivePath, expected.bytes, { mode: 0o600 });
      },
    });
    const files = new runtime.Files({ stateRoot: dirname(state.databasePath) });
    const authority = runtime.createAuthority();
    store.bindArchiveAuthority(authority.store);
    const prepared = store.prepareArchive(request);
    const archive = {
      archiveId: expected.archiveId,
      flowId: expected.header.flowId,
      requestSha256: expected.requestSha256,
      relativePath: expected.relativePath,
      archiveSha256: expected.archiveSha256,
      merkleRootSha256: expected.merkleRootSha256,
      createdAt: expected.header.createdAt,
      firstSequence: expected.header.firstSequence,
      lastSequence: expected.header.lastSequence,
      members: prepared.members,
    };
    const deletion = {
      archiveId: expected.archiveId,
      flowId: expected.header.flowId,
      archiveSha256: expected.archiveSha256,
      merkleRootSha256: expected.merkleRootSha256,
      members: prepared.members,
    };
    const commit = { prepared, archive };
    const publication = files.publishImmutable({ relativePath: expected.relativePath, bytes: expected.bytes });
    archivePath = publication.file.absolutePath;
    try {
      const capability = authority.service.issueCommitCapability({
        proof: authorityFileProof(expected, publication.file),
        commit,
        deletion,
      });
      const committed = store.commitArchiveManifest({ capability, ...commit }) as {
        replayed: boolean;
        deletionCapability: ArchiveDeletionCapability;
      };
      const before = telemetryRows(state.databasePath);
      replaceArchive = true;

      expect(() => store.deleteArchivedPayloads({ capability: committed.deletionCapability, ...deletion }))
        .toThrow(/identity changed|pinned.*changed|file.*changed|descriptor.*regular|no-follow/i);
      expect(telemetryRows(state.databasePath)).toEqual(before);
    } finally {
      publication.file.close();
      files.close();
      store.close();
    }
  });

  it("rejects cross-store, wrong-path, closed-handle, and replaced-file archive capabilities", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    seedArchivableEvents(runtime.Store, state);
    const request = archiveRequest({ requestId: "capability-file-binding" });
    const expected = expectedArchiveFromFixture(state, request);
    const store = new runtime.Store(state.databasePath);
    const files = new runtime.Files({ stateRoot: dirname(state.databasePath) });
    const authority = runtime.createAuthority();
    store.bindArchiveAuthority(authority.store);
    const prepared = store.prepareArchive(request);
    const archive = {
      archiveId: expected.archiveId,
      flowId: expected.header.flowId,
      requestSha256: expected.requestSha256,
      relativePath: expected.relativePath,
      archiveSha256: expected.archiveSha256,
      merkleRootSha256: expected.merkleRootSha256,
      createdAt: expected.header.createdAt,
      firstSequence: expected.header.firstSequence,
      lastSequence: expected.header.lastSequence,
      members: prepared.members,
    };
    const deletion = {
      archiveId: expected.archiveId,
      flowId: expected.header.flowId,
      archiveSha256: expected.archiveSha256,
      merkleRootSha256: expected.merkleRootSha256,
      members: prepared.members,
    };
    const commit = { prepared, archive };
    const publication = files.publishImmutable({ relativePath: expected.relativePath, bytes: expected.bytes });
    try {
      expect(() => authority.service.issueCommitCapability({
        proof: {
          ...authorityFileProof(expected, publication.file),
          relativePath: expected.relativePath.replace("telemetry-archives", "other-root"),
        },
        commit,
        deletion,
      })).toThrow(/path|root|binding|proof.*manifest/i);

      const closedCapability = authority.service.issueCommitCapability({
        proof: authorityFileProof(expected, publication.file),
        commit,
        deletion,
      });
      publication.file.close();
      const before = telemetryRows(state.databasePath);
      expect(() => store.commitArchiveManifest({ capability: closedCapability, ...commit }))
        .toThrow(/pinned.*closed|lease.*closed|file.*closed/i);
      expect(telemetryRows(state.databasePath)).toEqual(before);

      const otherState = fixture();
      const otherStore = new runtime.Store(otherState.databasePath);
      const otherAuthority = runtime.createAuthority();
      otherStore.bindArchiveAuthority(otherAuthority.store);
      try {
        const otherBefore = telemetryRows(otherState.databasePath);
        expect(() => otherStore.commitArchiveManifest({ capability: closedCapability, ...commit }))
          .toThrow(/capability.*not issued|not issued.*store/i);
        expect(telemetryRows(otherState.databasePath)).toEqual(otherBefore);
      } finally {
        otherStore.close();
      }

      const replacement = files.publishImmutable({ relativePath: expected.relativePath, bytes: expected.bytes });
      expect(Object.isFrozen(replacement.file)).toBe(true);
      expect(Object.isFrozen(Object.getPrototypeOf(replacement.file))).toBe(true);
      expect(Reflect.defineProperty(replacement.file, "assertCurrent", { value: () => undefined })).toBe(false);
      expect(Reflect.defineProperty(replacement.file, "read", { value: () => Buffer.from(expected.bytes) })).toBe(false);
      expect(Reflect.defineProperty(replacement.file, "absolutePath", { value: "/tmp/forged-archive" })).toBe(false);
      expect(Reflect.setPrototypeOf(replacement.file, Object.create(null))).toBe(false);
      const replacementCapability = authority.service.issueCommitCapability({
        proof: authorityFileProof(expected, replacement.file),
        commit,
        deletion,
      });
      rmSync(replacement.file.absolutePath);
      writeFileSync(replacement.file.absolutePath, expected.bytes);
      expect(() => store.commitArchiveManifest({ capability: replacementCapability, ...commit }))
        .toThrow(/identity changed|pinned.*changed|file.*changed|descriptor.*regular|no-follow/i);
      expect(telemetryRows(state.databasePath)).toEqual(before);
      replacement.file.close();
    } finally {
      files.close();
      store.close();
    }
  });

  it("round-trips a 256-byte Unicode provider session through archived usage and terminal replay", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    const providerSessionId = "é".repeat(128);
    expect(Buffer.byteLength(providerSessionId, "utf8")).toBe(256);
    const { seeded, usageInput, terminalInput } = seedArchivableUsageAndTerminal(
      runtime.Store,
      state,
      providerSessionId,
    );
    const request = archiveRequest({
      requestId: "usage-terminal-reopen",
      firstSequence: 1,
      lastSequence: 2,
    });
    const expected = expectedArchiveFromFixture(state, request);
    const originalEvents = eventRowsForSeed(state, seeded);
    const resources = serviceFor(runtime, state);
    let archivePath: string;
    try {
      const archived = resources.service.archive(request);
      archivePath = archived.archivePath;
      expect(archived).toEqual({
        archiveId: expected.archiveId,
        archivePath: archivePathFor(state, request.flowId, request.requestId),
        replayed: false,
      });
      assertCompletedArchive({ state, expected, seeded, request, originalEvents, archivePath });
    } finally {
      closeArchiveResources(resources);
    }

    const reopened = serviceFor(runtime, state);
    try {
      const durableRows = telemetryRows(state.databasePath);
      const durableFiles = archiveFileSnapshot(state);
      const durableDatabaseBytes = readFileSync(state.databasePath);
      for (const member of expected.members) {
        expect(reopened.service.readPayload({ flowId: request.flowId, eventId: member.eventId })).toEqual({
          payloadJson: member.payloadJson,
          payloadSha256: member.payloadSha256,
        });
      }
      expect(telemetryRows(state.databasePath)).toEqual(durableRows);
      expect(archiveFileSnapshot(state)).toEqual(durableFiles);

      expect(reopened.store.recordUsage(usageInput)).toEqual({
        usageId: usageInput.usageId,
        eventId: usageInput.usageId,
        replayed: true,
      });
      expect(telemetryRows(state.databasePath)).toEqual(durableRows);
      expect(archiveFileSnapshot(state)).toEqual(durableFiles);

      expect(reopened.store.recordAttemptTerminal(terminalInput)).toEqual({
        eventId: seeded.eventIds[1],
        replayed: true,
      });
      expect(telemetryRows(state.databasePath)).toEqual(durableRows);
      expect(archiveFileSnapshot(state)).toEqual(durableFiles);

      expect(reopened.service.archive(request)).toEqual({
        archiveId: expected.archiveId,
        archivePath,
        replayed: true,
      });
      expect(telemetryRows(state.databasePath)).toEqual(durableRows);
      expect(archiveFileSnapshot(state)).toEqual(durableFiles);
      expect(readFileSync(state.databasePath).equals(durableDatabaseBytes)).toBe(true);
      expect(readFileSync(archivePath).equals(expected.bytes)).toBe(true);
    } finally {
      closeArchiveResources(reopened);
    }
  });

  it.each([
    {
      label: "archive sha",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE agent_event_archives SET archive_sha256=?",
      ).run("1".repeat(64)),
    },
    {
      label: "Merkle root",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE agent_event_archives SET merkle_root_sha256=?",
      ).run("2".repeat(64)),
    },
    {
      label: "derived path",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE agent_event_archives SET archive_path=?",
      ).run(`telemetry-archives/${"3".repeat(64)}/${"4".repeat(64)}.jsonl`),
    },
    {
      label: "first sequence",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE agent_event_archives SET first_sequence=2",
      ).run(),
    },
    {
      label: "last sequence",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE agent_event_archives SET last_sequence=4",
      ).run(),
    },
    {
      label: "member count",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE agent_event_archives SET member_count=4",
      ).run(),
    },
  ])("rejects an independently tampered manifest $label on reopen without changing DB or files", async ({ mutate }) => {
    const runtime = await loadRuntime();
    const state = fixture();
    const request = archiveRequest({ requestId: "manifest-tamper" });
    completeGenericArchive(runtime, state, request);
    const db = new Database(state.databasePath);
    db.pragma("foreign_keys = ON");
    try { mutate(db); }
    finally { db.close(); }
    const tamperedRows = telemetryRows(state.databasePath);
    const tamperedFiles = archiveFileSnapshot(state);
    const tamperedDatabaseBytes = readFileSync(state.databasePath);
    expect(() => {
      const store = new runtime.Store(state.databasePath);
      store.close();
    }).toThrow(/archive|manifest|anchor|range|member|path|digest|integrity/i);
    expect(telemetryRows(state.databasePath)).toEqual(tamperedRows);
    expect(archiveFileSnapshot(state)).toEqual(tamperedFiles);
    expect(readFileSync(state.databasePath).equals(tamperedDatabaseBytes)).toBe(true);
  });

  it.each(["missing", "orphan"] as const)(
    "rejects a %s canonical archive anchor on reopen without changing DB or files",
    async (variant) => {
      const runtime = await loadRuntime();
      const state = fixture();
      const request = archiveRequest({ requestId: `anchor-${variant}` });
      const { expected } = completeGenericArchive(runtime, state, request);
      const db = new Database(state.databasePath);
      db.pragma("foreign_keys = ON");
      try {
        if (variant === "missing") {
          const eventId = hex(canonicalJson({ archiveId: expected.archiveId, eventVersion: "1" }));
          db.prepare("DELETE FROM agent_event_payloads WHERE event_id=?").run(eventId);
          db.prepare("DELETE FROM agent_events WHERE event_id=?").run(eventId);
        } else {
          appendCanonicalAnchor(db, {
            flowId: request.flowId,
            archiveId: "5".repeat(64),
            archiveSha256: "6".repeat(64),
            merkleRootSha256: "7".repeat(64),
            firstSequence: 1,
            lastSequence: 1,
            memberCount: 1,
            createdAt: request.now + 1,
          });
        }
      } finally {
        db.close();
      }
      const tamperedRows = telemetryRows(state.databasePath);
      const tamperedFiles = archiveFileSnapshot(state);
      const tamperedDatabaseBytes = readFileSync(state.databasePath);
      expect(() => {
        const store = new runtime.Store(state.databasePath);
        store.close();
      }).toThrow(/archive|anchor|manifest|binding|integrity/i);
      expect(telemetryRows(state.databasePath)).toEqual(tamperedRows);
      expect(archiveFileSnapshot(state)).toEqual(tamperedFiles);
      expect(readFileSync(state.databasePath).equals(tamperedDatabaseBytes)).toBe(true);
    },
  );

  it("rejects a fully bound overlapping manifest and canonical anchor on reopen", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    const request = archiveRequest({ requestId: "overlap-base" });
    const { expected } = completeGenericArchive(runtime, state, request);
    const overlapIdentity = oracleArchiveIdentity(request.flowId, "overlap-injected");
    const overlapArchiveSha256 = hex("overlap-archive-bytes");
    const overlapMerkleRootSha256 = hex("overlap-merkle-root");
    const overlapMembers = expected.members.slice(1);
    const db = new Database(state.databasePath);
    db.pragma("foreign_keys = ON");
    try {
      db.prepare(`INSERT INTO agent_event_archives
        (archive_id,flow_id,first_sequence,last_sequence,archive_path,archive_sha256,
         merkle_root_sha256,member_count,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
        overlapIdentity.archiveId,
        request.flowId,
        2,
        3,
        overlapIdentity.relativePath,
        overlapArchiveSha256,
        overlapMerkleRootSha256,
        overlapMembers.length,
        request.now + 1,
      );
      const insertMember = db.prepare(`INSERT INTO agent_event_archive_members
        (flow_id,archive_id,event_id,payload_sha256) VALUES (?,?,?,?)`);
      for (const member of overlapMembers) {
        insertMember.run(request.flowId, overlapIdentity.archiveId, member.eventId, member.payloadSha256);
      }
      const restorePayload = db.prepare(`INSERT INTO agent_event_payloads
        (event_id,payload_json,payload_sha256) VALUES (?,?,?)`);
      for (const member of expected.members) {
        restorePayload.run(member.eventId, member.payloadJson, member.payloadSha256);
      }
      appendCanonicalAnchor(db, {
        flowId: request.flowId,
        archiveId: overlapIdentity.archiveId,
        archiveSha256: overlapArchiveSha256,
        merkleRootSha256: overlapMerkleRootSha256,
        firstSequence: 2,
        lastSequence: 3,
        memberCount: overlapMembers.length,
        createdAt: request.now + 1,
      });
    } finally {
      db.close();
    }
    const tamperedRows = telemetryRows(state.databasePath);
    const tamperedFiles = archiveFileSnapshot(state);
    const tamperedDatabaseBytes = readFileSync(state.databasePath);
    expect(() => {
      const store = new runtime.Store(state.databasePath);
      store.close();
    }).toThrow(/archive.*overlap|overlap.*archive/i);
    expect(telemetryRows(state.databasePath)).toEqual(tamperedRows);
    expect(archiveFileSnapshot(state)).toEqual(tamperedFiles);
    expect(readFileSync(state.databasePath).equals(tamperedDatabaseBytes)).toBe(true);
  });

  it("rejects a self-consistent manifest and anchor rehash when pinned segment bytes retain the original root", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    const request = archiveRequest({ requestId: "self-consistent-wrong-binding" });
    const { seeded, expected } = completeGenericArchive(runtime, state, request);
    const forgedMerkleRoot = hex("forged-self-consistent-merkle-root");
    const db = new Database(state.databasePath);
    db.pragma("foreign_keys = ON");
    try {
      db.prepare("UPDATE agent_event_archives SET merkle_root_sha256=? WHERE archive_id=?")
        .run(forgedMerkleRoot, expected.archiveId);
      rewriteCanonicalAnchor(db, expected.archiveId, (data) => ({
        ...data,
        merkleRootSha256: forgedMerkleRoot,
      }));
    } finally {
      db.close();
    }

    const resources = serviceFor(runtime, state);
    try {
      const tamperedRows = telemetryRows(state.databasePath);
      const originalFiles = archiveFileSnapshot(state);
      const tamperedDatabaseBytes = readFileSync(state.databasePath);
      expect(() => resources.service.readPayload({
        flowId: request.flowId,
        eventId: seeded.eventIds[0]!,
      })).toThrow(/archive|merkle|root|manifest|segment|hash|mismatch|integrity/i);
      expect(telemetryRows(state.databasePath)).toEqual(tamperedRows);
      expect(archiveFileSnapshot(state)).toEqual(originalFiles);
      expect(readFileSync(state.databasePath).equals(tamperedDatabaseBytes)).toBe(true);
      expect(readFileSync(originalFiles[0]!.path).equals(expected.bytes)).toBe(true);
    } finally {
      closeArchiveResources(resources);
    }
  });
});

describe("FlowTelemetryStore archive eligibility", () => {
  it("rejects a secret-like archive requestId at the store seam with zero DB effect", async () => {
    const runtime = await loadRuntime();
    const state = fixture();
    seedArchivableEvents(runtime.Store, state);
    const store = new runtime.Store(state.databasePath);
    try {
      const before = telemetryRows(state.databasePath);
      const databaseFilesBefore = stateDatabaseFileSnapshot(state.databasePath);
      expect(() => store.prepareArchive(archiveRequest({ requestId: "ghp_abcdefghijklmno" })))
        .toThrow(/archive request id.*(identity|sensitive|secret|safe|invalid)/i);
      expect(stateDatabaseFileSnapshot(state.databasePath)).toEqual(databaseFilesBefore);
      expect(telemetryRows(state.databasePath)).toEqual(before);
    } finally {
      store.close();
    }
  });

  it.each([
    ["terminal 90d-1 small", "succeeded", 90 * DAY_MS - 1, GIB - 1n, false],
    ["terminal 90d small", "succeeded", 90 * DAY_MS, GIB - 1n, true],
    ["terminal young 1GiB-1", "succeeded", 1, GIB - 1n, false],
    ["terminal young 1GiB", "succeeded", 1, GIB, true],
    ["terminal young huge bigint", "succeeded", 1, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true],
    ["failed old small", "failed", 90 * DAY_MS, GIB - 1n, true],
    ["cancelled young large", "cancelled", 1, GIB, true],
    ["active old large", "running", 100 * DAY_MS, GIB, false],
    ["reconciling old large", "needs_reconciliation", 100 * DAY_MS, GIB, false],
  ] as const)("enforces %s inside the store with a zero-mutation prepare", async (
    _case, status, age, databaseBytes, eligible,
  ) => {
    const runtime = await loadRuntime();
    const state = fixture();
    const now = 1_800_000_000_000;
    const updatedAt = now - age;
    seedArchivableEvents(runtime.Store, state, 3, DEFAULT_ARCHIVE_FLOW, status, updatedAt);
    assertArchiveFlowLifecycle(state, DEFAULT_ARCHIVE_FLOW, status, updatedAt);
    const store = new runtime.Store(state.databasePath);
    try {
      const before = telemetryRows(state.databasePath);
      const invoke = () => store.prepareArchive(archiveRequest({ now, databaseBytes }));
      if (eligible) {
        const expected = expectedArchiveFromFixture(state, archiveRequest({ now, databaseBytes }));
        expect(invoke()).toEqual(expect.objectContaining({
          archiveId: expected.archiveId,
          requestSha256: expected.requestSha256,
          relativePath: expected.relativePath,
          replayed: false,
          members: expected.members.map((member) => ({
            eventId: member.eventId,
            sequenceNo: member.sequenceNo,
            eventSha256: member.eventSha256,
            payloadSha256: member.payloadSha256,
            payloadJson: member.payloadJson,
          })),
        }));
      } else {
        expect(invoke).toThrow(/eligible|terminal|retention|archive/i);
      }
      expect(telemetryRows(state.databasePath)).toEqual(before);
    } finally {
      store.close();
    }
  });

  it.each([
    ["negative bigint", -1n, false],
    ["safe integer number", 1_024, false],
    ["fractional number", 1.5, false],
    ["NaN", Number.NaN, false],
    ["positive infinity", Number.POSITIVE_INFINITY, false],
    ["numeric string", "1073741824", false],
    ["boolean", true, false],
    ["null", null, false],
    ["undefined", undefined, false],
    ["missing", undefined, true],
  ] as const)("rejects invalid databaseBytes: %s with exact zero DB mutation", async (
    _case,
    databaseBytes,
    omit,
  ) => {
    const runtime = await loadRuntime();
    const state = fixture();
    seedArchivableEvents(runtime.Store, state);
    const store = new runtime.Store(state.databasePath);
    try {
      const request = archiveRequest({ databaseBytes });
      if (omit) delete (request as Partial<ArchiveInvocation>).databaseBytes;
      const before = telemetryRows(state.databasePath);
      expect(() => store.prepareArchive(request)).toThrow(/databaseBytes|database bytes|bigint|nonnegative|size|invalid/i);
      expect(telemetryRows(state.databasePath)).toEqual(before);
    } finally {
      store.close();
    }
  });
});
