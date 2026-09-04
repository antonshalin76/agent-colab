import { z } from "zod";
import { canonicalJson, computeBytesSha256 } from "../domain/canonical-json.js";
import {
  assertTelemetryStableId,
  type TelemetryStableIdField,
} from "./flow-telemetry-identity.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ARCHIVE_PATH_PATTERN = /^telemetry-archives\/[a-f0-9]{64}\/[a-f0-9]{64}\.jsonl$/;
const MAX_PAYLOAD_BYTES = 4_096;

export const AGENT_EVENT_ARCHIVE_MERKLE_ALGORITHM =
  "sha256-0x00-leaf-0x01-parent-duplicate-odd/v1" as const;

const SafeNonnegativeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger);
const SafePositiveInteger = SafeNonnegativeInteger.refine((value) => value > 0);
const Sha256 = z.string().regex(SHA256_PATTERN);
const StableId = (field: TelemetryStableIdField) => z.string().superRefine((value, context) => {
  try {
    assertTelemetryStableId(value, field);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : `${field} identity is invalid`,
    });
  }
});

const PreparedMemberSchema = z.object({
  eventId: StableId("eventId"),
  sequenceNo: SafePositiveInteger,
  eventSha256: Sha256,
  payloadSha256: Sha256,
  payloadJson: z.string().min(1),
}).strict();

const MemberSchema = PreparedMemberSchema.extend({
  schemaVersion: z.literal("AgentEventArchiveMember/v1"),
  flowId: StableId("flowId"),
}).strict();

const RequestSchema = z.object({
  schemaVersion: z.literal("AgentEventArchiveRequest/v1"),
  requestId: StableId("requestId"),
  flowId: StableId("flowId"),
  firstSequence: SafePositiveInteger,
  lastSequence: SafePositiveInteger,
  membersSha256: Sha256,
}).strict();

const HeaderSchema = z.object({
  schemaVersion: z.literal("AgentEventArchive/v1"),
  archiveId: Sha256,
  flowId: StableId("flowId"),
  requestSha256: Sha256,
  firstSequence: SafePositiveInteger,
  lastSequence: SafePositiveInteger,
  memberCount: SafePositiveInteger,
  merkleAlgorithm: z.literal(AGENT_EVENT_ARCHIVE_MERKLE_ALGORITHM),
  merkleRootSha256: Sha256,
  createdAt: SafeNonnegativeInteger,
}).strict();

const ArchiveIdentityInputSchema = z.object({
  flowId: StableId("flowId"),
  requestId: StableId("requestId"),
}).strict();
const ArchiveBuildInputSchema = z.object({
  flowId: StableId("flowId"),
  requestId: StableId("requestId"),
  createdAt: SafeNonnegativeInteger,
  members: z.array(PreparedMemberSchema).min(1),
}).strict();

export interface AgentEventArchiveMember {
  readonly schemaVersion: "AgentEventArchiveMember/v1";
  readonly flowId: string;
  readonly eventId: string;
  readonly sequenceNo: number;
  readonly eventSha256: string;
  readonly payloadSha256: string;
  readonly payloadJson: string;
}

export interface AgentEventArchiveRequest {
  readonly schemaVersion: "AgentEventArchiveRequest/v1";
  readonly requestId: string;
  readonly flowId: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly membersSha256: string;
}

export interface AgentEventArchiveHeader {
  readonly schemaVersion: "AgentEventArchive/v1";
  readonly archiveId: string;
  readonly flowId: string;
  readonly requestSha256: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly memberCount: number;
  readonly merkleAlgorithm: typeof AGENT_EVENT_ARCHIVE_MERKLE_ALGORITHM;
  readonly merkleRootSha256: string;
  readonly createdAt: number;
}

export interface BuiltAgentEventArchive {
  readonly archiveId: string;
  readonly request: AgentEventArchiveRequest;
  readonly requestSha256: string;
  readonly relativePath: string;
  readonly header: AgentEventArchiveHeader;
  readonly members: readonly AgentEventArchiveMember[];
  readonly bytes: Buffer;
  readonly archiveSha256: string;
  readonly merkleRootSha256: string;
}

export interface AgentEventArchiveManifestProjection {
  readonly archiveId: string;
  readonly flowId: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly relativePath: string;
  readonly archiveSha256: string;
  readonly merkleRootSha256: string;
  readonly memberCount: number;
  readonly createdAt: number;
}

export interface AgentEventArchiveMemberProjection {
  readonly eventId: string;
  readonly sequenceNo: number;
  readonly eventSha256: string;
  readonly payloadSha256: string;
}

export interface VerifiedStoredAgentEventArchive {
  readonly header: AgentEventArchiveHeader;
  readonly members: readonly AgentEventArchiveMember[];
  readonly bytes: Buffer;
  readonly archiveSha256: string;
  readonly merkleRootSha256: string;
}

const sha256 = (value: string | Buffer): string =>
  computeBytesSha256(value);

const sha256Buffer = (value: Buffer): Buffer => Buffer.from(computeBytesSha256(value), "hex");

function parseIdentityInput(input: unknown): { flowId: string; requestId: string } {
  const result = ArchiveIdentityInputSchema.safeParse(input);
  if (!result.success) {
    throw new Error("archive requestId and flowId must be safe ASCII identifiers of length 1..128");
  }
  return result.data;
}

export function deriveTelemetryArchiveIdentity(input: { flowId: string; requestId: string }): {
  archiveId: string;
  relativePath: string;
} {
  const parsed = parseIdentityInput(input);
  const archiveId = sha256(canonicalJson(parsed));
  return {
    archiveId,
    relativePath: `telemetry-archives/${sha256(parsed.flowId)}/${sha256(archiveId)}.jsonl`,
  };
}

function validatePayload(member: AgentEventArchiveMember): void {
  if (Buffer.byteLength(member.payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("archive member payload exceeds the telemetry payload bound");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(member.payloadJson);
  } catch {
    throw new Error("archive member payload is not valid JSON");
  }
  if (canonicalJson(payload) !== member.payloadJson) {
    throw new Error("archive member payload is not canonical JSON");
  }
  if (sha256(member.payloadJson) !== member.payloadSha256) {
    throw new Error("archive member payload hash mismatch");
  }
}

function validateMembers(
  members: readonly AgentEventArchiveMember[],
  flowId: string,
  firstSequence: number,
  lastSequence: number,
): void {
  if (members.length === 0) throw new Error("archive member set cannot be empty");
  if (lastSequence - firstSequence + 1 !== members.length) {
    throw new Error("archive member range is not contiguous");
  }
  const eventIds = new Set<string>();
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index]!;
    if (member.flowId !== flowId || member.sequenceNo !== firstSequence + index) {
      throw new Error("archive member flow, order, or contiguous sequence is invalid");
    }
    if (eventIds.has(member.eventId)) throw new Error("archive member event identity is duplicated");
    eventIds.add(member.eventId);
    validatePayload(member);
  }
}

function merkleRoot(members: readonly AgentEventArchiveMember[]): string {
  if (members.length === 0) throw new Error("archive Merkle tree cannot be empty");
  let level = members.map((member) => sha256Buffer(Buffer.concat([
    Buffer.from([0]),
    Buffer.from(canonicalJson(member), "utf8"),
  ])));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1] ?? left;
      next.push(sha256Buffer(Buffer.concat([Buffer.from([1]), left, right])));
    }
    level = next;
  }
  return level[0]!.toString("hex");
}

function archiveBytes(
  header: AgentEventArchiveHeader,
  members: readonly AgentEventArchiveMember[],
): Buffer {
  return Buffer.from(`${[header, ...members].map(canonicalJson).join("\n")}\n`, "utf8");
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an invalid exact schema`);
  }
}

const BUILT_ARCHIVE_KEYS = [
  "archiveId", "request", "requestSha256", "relativePath", "header", "members", "bytes",
  "archiveSha256", "merkleRootSha256",
] as const;

function verifyStructuredArchive(archive: BuiltAgentEventArchive): void {
  if (!archive || typeof archive !== "object" || Array.isArray(archive)) {
    throw new Error("archive value is invalid");
  }
  exactKeys(archive, BUILT_ARCHIVE_KEYS, "archive value");
  if (!Buffer.isBuffer(archive.bytes)) throw new Error("archive bytes must be a Buffer");

  const requestResult = RequestSchema.safeParse(archive.request);
  const headerResult = HeaderSchema.safeParse(archive.header);
  const membersResult = z.array(MemberSchema).min(1).safeParse(archive.members);
  if (!requestResult.success || !headerResult.success || !membersResult.success) {
    throw new Error("archive request, header, or member schema is invalid");
  }
  const request = requestResult.data as AgentEventArchiveRequest;
  const header = headerResult.data as AgentEventArchiveHeader;
  const members = membersResult.data as AgentEventArchiveMember[];
  const identity = deriveTelemetryArchiveIdentity({ flowId: request.flowId, requestId: request.requestId });

  validateMembers(members, request.flowId, request.firstSequence, request.lastSequence);
  const membersSha256 = sha256(canonicalJson(members));
  const requestSha256 = sha256(canonicalJson(request));
  const expectedMerkleRoot = merkleRoot(members);
  const expectedBytes = archiveBytes(header, members);

  if (request.membersSha256 !== membersSha256 || archive.requestSha256 !== requestSha256 ||
      header.requestSha256 !== requestSha256) {
    throw new Error("archive request or member-set hash mismatch");
  }
  if (archive.archiveId !== identity.archiveId || header.archiveId !== identity.archiveId ||
      archive.relativePath !== identity.relativePath) {
    throw new Error("archive identity or path mismatch");
  }
  if (header.flowId !== request.flowId || header.firstSequence !== request.firstSequence ||
      header.lastSequence !== request.lastSequence || header.memberCount !== members.length) {
    throw new Error("archive header range or member count mismatch");
  }
  if (header.merkleRootSha256 !== expectedMerkleRoot ||
      archive.merkleRootSha256 !== expectedMerkleRoot) {
    throw new Error("archive Merkle root mismatch");
  }
  if (!expectedBytes.equals(archive.bytes) || archive.archiveSha256 !== sha256(archive.bytes)) {
    throw new Error("archive bytes are not exact canonical JSONL");
  }
}

export function buildAgentEventArchive(input: {
  flowId: string;
  requestId: string;
  createdAt: number;
  members: readonly Omit<AgentEventArchiveMember, "schemaVersion" | "flowId">[];
}): BuiltAgentEventArchive {
  const parsedResult = ArchiveBuildInputSchema.safeParse(input);
  if (!parsedResult.success) {
    throw new Error("archive build input has an invalid identity, timestamp, or member schema");
  }
  const parsed = parsedResult.data;
  const identity = deriveTelemetryArchiveIdentity({ flowId: parsed.flowId, requestId: parsed.requestId });
  const members: AgentEventArchiveMember[] = parsed.members.map((member) => ({
    schemaVersion: "AgentEventArchiveMember/v1",
    flowId: parsed.flowId,
    ...member,
  }));
  const firstSequence = members[0]!.sequenceNo;
  const lastSequence = members.at(-1)!.sequenceNo;
  validateMembers(members, parsed.flowId, firstSequence, lastSequence);
  const request: AgentEventArchiveRequest = {
    schemaVersion: "AgentEventArchiveRequest/v1",
    requestId: parsed.requestId,
    flowId: parsed.flowId,
    firstSequence,
    lastSequence,
    membersSha256: sha256(canonicalJson(members)),
  };
  const requestSha256 = sha256(canonicalJson(request));
  const merkleRootSha256 = merkleRoot(members);
  const header: AgentEventArchiveHeader = {
    schemaVersion: "AgentEventArchive/v1",
    archiveId: identity.archiveId,
    flowId: parsed.flowId,
    requestSha256,
    firstSequence,
    lastSequence,
    memberCount: members.length,
    merkleAlgorithm: AGENT_EVENT_ARCHIVE_MERKLE_ALGORITHM,
    merkleRootSha256,
    createdAt: parsed.createdAt,
  };
  const bytes = archiveBytes(header, members);
  const archive: BuiltAgentEventArchive = {
    archiveId: identity.archiveId,
    request,
    requestSha256,
    relativePath: identity.relativePath,
    header,
    members,
    bytes,
    archiveSha256: sha256(bytes),
    merkleRootSha256,
  };
  verifyStructuredArchive(archive);
  return archive;
}

export function verifyAgentEventArchive(archive: BuiltAgentEventArchive): void {
  try {
    verifyStructuredArchive(archive);
  } catch (error) {
    if (error instanceof Error && /^archive\b/i.test(error.message)) throw error;
    throw new Error("archive verification failed", { cause: error });
  }
}

function parseArchiveJsonl(bytes: Buffer): {
  header: AgentEventArchiveHeader;
  members: AgentEventArchiveMember[];
} {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.at(-1) !== 10) {
    throw new Error("archive segment is empty, truncated, or lacks its final LF");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("archive segment is not valid UTF-8");
  const body = text.slice(0, -1);
  if (body.length === 0 || body.endsWith("\n")) throw new Error("archive segment has an empty JSONL record");
  const lines = body.split("\n");
  if (lines.length < 2) throw new Error("archive segment must contain a header and at least one member");
  const values = lines.map((line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("archive segment contains invalid JSON");
    }
    if (canonicalJson(value) !== line) throw new Error("archive segment contains non-canonical JSONL");
    return value;
  });
  const headerResult = HeaderSchema.safeParse(values[0]);
  const membersResult = z.array(MemberSchema).min(1).safeParse(values.slice(1));
  if (!headerResult.success || !membersResult.success) {
    throw new Error("archive segment header or member schema is invalid");
  }
  return {
    header: headerResult.data as AgentEventArchiveHeader,
    members: membersResult.data as AgentEventArchiveMember[],
  };
}

export function verifyStoredAgentEventArchive(input: {
  readonly bytes: Buffer;
  readonly manifest: AgentEventArchiveManifestProjection;
  readonly members: readonly AgentEventArchiveMemberProjection[];
  readonly requestId?: string;
}): VerifiedStoredAgentEventArchive {
  const { header, members } = parseArchiveJsonl(input.bytes);
  const manifest = input.manifest;
  if (!ARCHIVE_PATH_PATTERN.test(manifest.relativePath) ||
      manifest.relativePath !== `telemetry-archives/${sha256(manifest.flowId)}/${sha256(manifest.archiveId)}.jsonl`) {
    throw new Error("archive manifest path is invalid");
  }
  validateMembers(members, manifest.flowId, manifest.firstSequence, manifest.lastSequence);
  const computedMerkle = merkleRoot(members);
  const computedArchiveSha256 = sha256(input.bytes);
  if (header.archiveId !== manifest.archiveId || header.flowId !== manifest.flowId ||
      header.firstSequence !== manifest.firstSequence || header.lastSequence !== manifest.lastSequence ||
      header.memberCount !== manifest.memberCount || header.createdAt !== manifest.createdAt ||
      header.merkleRootSha256 !== manifest.merkleRootSha256 || computedMerkle !== manifest.merkleRootSha256 ||
      computedArchiveSha256 !== manifest.archiveSha256) {
    throw new Error("archive segment does not match its durable manifest");
  }
  if (input.members.length !== members.length) throw new Error("archive durable membership count mismatch");
  for (let index = 0; index < members.length; index += 1) {
    const actual = members[index]!;
    const expected = input.members[index]!;
    if (actual.eventId !== expected.eventId || actual.sequenceNo !== expected.sequenceNo ||
        actual.eventSha256 !== expected.eventSha256 || actual.payloadSha256 !== expected.payloadSha256) {
      throw new Error("archive durable member projection mismatch");
    }
  }
  if (input.requestId !== undefined) {
    const identity = deriveTelemetryArchiveIdentity({ flowId: manifest.flowId, requestId: input.requestId });
    const request: AgentEventArchiveRequest = {
      schemaVersion: "AgentEventArchiveRequest/v1",
      requestId: input.requestId,
      flowId: manifest.flowId,
      firstSequence: manifest.firstSequence,
      lastSequence: manifest.lastSequence,
      membersSha256: sha256(canonicalJson(members)),
    };
    if (identity.archiveId !== manifest.archiveId || identity.relativePath !== manifest.relativePath ||
        sha256(canonicalJson(request)) !== header.requestSha256) {
      throw new Error("archive request identity conflicts with the stored segment");
    }
  }
  return {
    header,
    members,
    bytes: Buffer.from(input.bytes),
    archiveSha256: computedArchiveSha256,
    merkleRootSha256: computedMerkle,
  };
}
