import { canonicalJson, computeBytesSha256 } from "../domain/canonical-json.js";
import {
  buildAgentEventArchive,
  deriveTelemetryArchiveIdentity,
  verifyStoredAgentEventArchive,
  type AgentEventArchiveManifestProjection,
  type AgentEventArchiveMemberProjection,
  type BuiltAgentEventArchive,
} from "../runtime/flow-telemetry-archive.js";
import type { PinnedStateFile } from "../store/state-file-durability.js";
import { assertTelemetryStableId } from "../runtime/flow-telemetry-identity.js";
import {
  createFlowTelemetryArchiveAuthority,
  type ArchiveCommitCapability,
  type ArchiveDeletionCapability,
  type FlowTelemetryArchiveServiceAuthorityPort,
  type FlowTelemetryArchiveStoreAuthorityPort,
} from "./flow-telemetry-archive-authority.js";

interface ArchiveMemberProjection extends AgentEventArchiveMemberProjection {
  readonly payloadJson?: string;
}

interface FreshArchiveMember extends ArchiveMemberProjection {
  readonly payloadJson: string;
}

interface FreshArchivePreparation {
  readonly phase: "new";
  readonly archiveId: string;
  readonly flowId: string;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly relativePath: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly createdAt: number;
  readonly expectedFlowUpdatedAt: number;
  readonly replayed: false;
  readonly members: readonly FreshArchiveMember[];
}

interface CommittedArchivePreparation extends AgentEventArchiveManifestProjection {
  readonly phase: "committed";
  readonly requestId: string;
  readonly requestSha256: null;
  readonly replayed: true;
  readonly members: readonly ArchiveMemberProjection[];
}

type ArchivePreparation = FreshArchivePreparation | CommittedArchivePreparation;

interface ArchiveStorePort {
  bindArchiveAuthority(authority: FlowTelemetryArchiveStoreAuthorityPort): void;
  prepareArchive(input: unknown): ArchivePreparation;
  commitArchiveManifest(input: {
    readonly capability: ArchiveCommitCapability;
    readonly prepared: FreshArchivePreparation;
    readonly archive: {
      readonly archiveId: string;
      readonly flowId: string;
      readonly requestSha256: string;
      readonly relativePath: string;
      readonly archiveSha256: string;
      readonly merkleRootSha256: string;
      readonly createdAt: number;
      readonly firstSequence: number;
      readonly lastSequence: number;
      readonly members: readonly ArchiveMemberProjection[];
    };
  }): { readonly replayed: boolean; readonly deletionCapability: ArchiveDeletionCapability };
  deleteArchivedPayloads(input: {
    readonly capability: ArchiveDeletionCapability;
    readonly archiveId: string;
    readonly flowId: string;
    readonly archiveSha256: string;
    readonly merkleRootSha256: string;
    readonly members: readonly ArchiveMemberProjection[];
  }): { readonly replayed: boolean };
  resolvePayload(input: { readonly flowId: string; readonly eventId: string }):
    | { readonly kind: "live"; readonly payloadJson: string; readonly payloadSha256: string }
    | {
      readonly kind: "archived";
      readonly manifest: AgentEventArchiveManifestProjection & {
        readonly members: readonly ArchiveMemberProjection[];
      };
      readonly targetEventId: string;
    };
  verifyResolvedPayload(input: {
    readonly flowId: string;
    readonly eventId: string;
    readonly payloadJson: string;
    readonly payloadSha256: string;
  }): void;
}

interface ArchiveFilesPort {
  withFlowLock<T>(flowId: string, operation: () => T): T;
  publishImmutable(input: {
    readonly relativePath: string;
    readonly bytes: Buffer;
  }): { readonly file: PinnedStateFile; readonly created: boolean };
  openPinned(relativePath: string): PinnedStateFile;
}

export interface FlowTelemetryArchiveServiceOptions {
  readonly store: ArchiveStorePort;
  readonly files: ArchiveFilesPort;
  readonly faultInjector?: (point: string) => void;
  readonly authority?: {
    readonly service: FlowTelemetryArchiveServiceAuthorityPort;
    readonly store: FlowTelemetryArchiveStoreAuthorityPort;
  };
}

export interface FlowTelemetryArchiveResult {
  readonly archiveId: string;
  readonly archivePath: string;
  readonly replayed: boolean;
}

export interface FlowTelemetryPayloadResult {
  readonly payloadJson: string;
  readonly payloadSha256: string;
}

interface ArchiveRequestIdentity {
  readonly flowId: string;
  readonly requestId: string;
}

function archiveRequestIdentity(input: unknown): ArchiveRequestIdentity {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("archive request must be an object");
  }
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.flowId !== "string" || typeof candidate.requestId !== "string") {
    throw new Error("archive request flowId and requestId must be strings");
  }
  deriveTelemetryArchiveIdentity({ flowId: candidate.flowId, requestId: candidate.requestId });
  return { flowId: candidate.flowId, requestId: candidate.requestId };
}

function payloadIdentity(input: unknown): { flowId: string; eventId: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("telemetry payload request must be an object");
  }
  const candidate = input as Record<string, unknown>;
  return {
    flowId: assertTelemetryStableId(candidate.flowId, "flowId", "telemetry payload flowId"),
    eventId: assertTelemetryStableId(candidate.eventId, "eventId", "telemetry payload eventId"),
  };
}

function manifestFromBuilt(archive: BuiltAgentEventArchive): AgentEventArchiveManifestProjection {
  return {
    archiveId: archive.archiveId,
    flowId: archive.header.flowId,
    firstSequence: archive.header.firstSequence,
    lastSequence: archive.header.lastSequence,
    relativePath: archive.relativePath,
    archiveSha256: archive.archiveSha256,
    merkleRootSha256: archive.merkleRootSha256,
    memberCount: archive.members.length,
    createdAt: archive.header.createdAt,
  };
}

function manifestProjection(
  prepared: AgentEventArchiveManifestProjection,
): AgentEventArchiveManifestProjection {
  return {
    archiveId: prepared.archiveId,
    flowId: prepared.flowId,
    firstSequence: prepared.firstSequence,
    lastSequence: prepared.lastSequence,
    relativePath: prepared.relativePath,
    archiveSha256: prepared.archiveSha256,
    merkleRootSha256: prepared.merkleRootSha256,
    memberCount: prepared.memberCount,
    createdAt: prepared.createdAt,
  };
}

function assertPreparedIdentity(
  prepared: ArchivePreparation,
  requested: ArchiveRequestIdentity,
): void {
  const identity = deriveTelemetryArchiveIdentity(requested);
  if (prepared.flowId !== requested.flowId || prepared.requestId !== requested.requestId ||
      prepared.archiveId !== identity.archiveId || prepared.relativePath !== identity.relativePath) {
    throw new Error("archive preparation conflicts with the requested immutable identity");
  }
}

function assertFreshPreparation(
  prepared: FreshArchivePreparation,
  archive: BuiltAgentEventArchive,
): void {
  if (archive.archiveId !== prepared.archiveId || archive.requestSha256 !== prepared.requestSha256 ||
      archive.relativePath !== prepared.relativePath || archive.header.flowId !== prepared.flowId ||
      archive.header.createdAt !== prepared.createdAt ||
      archive.header.firstSequence !== prepared.firstSequence ||
      archive.header.lastSequence !== prepared.lastSequence) {
    throw new Error("archive build conflicts with its store preparation");
  }
}

function verifyPinnedArchive(input: {
  readonly file: PinnedStateFile;
  readonly manifest: AgentEventArchiveManifestProjection;
  readonly members: readonly ArchiveMemberProjection[];
  readonly requestId?: string;
}): ReturnType<typeof verifyStoredAgentEventArchive> {
  const bytes = input.file.read();
  const verified = verifyStoredAgentEventArchive({
    bytes,
    manifest: input.manifest,
    members: input.members,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  });
  input.file.assertCurrent();
  return verified;
}

function validateLivePayload(result: FlowTelemetryPayloadResult): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.payloadJson);
  } catch {
    throw new Error("live telemetry payload is not valid JSON");
  }
  if (canonicalJson(parsed) !== result.payloadJson ||
      computeBytesSha256(result.payloadJson) !== result.payloadSha256) {
    throw new Error("live telemetry payload canonical bytes or digest are invalid");
  }
}

export class FlowTelemetryArchiveService {
  readonly #store: ArchiveStorePort;
  readonly #files: ArchiveFilesPort;
  readonly #faultInjector: ((point: string) => void) | undefined;
  readonly #authority: FlowTelemetryArchiveServiceAuthorityPort;

  constructor(input: FlowTelemetryArchiveServiceOptions) {
    this.#store = input.store;
    this.#files = input.files;
    this.#faultInjector = input.faultInjector;
    const authority = input.authority ?? createFlowTelemetryArchiveAuthority();
    this.#store.bindArchiveAuthority(authority.store);
    this.#authority = authority.service;
  }

  archive(input: unknown): FlowTelemetryArchiveResult {
    const requested = archiveRequestIdentity(input);
    return this.#files.withFlowLock(requested.flowId, () => {
      const prepared = this.#store.prepareArchive(input);
      assertPreparedIdentity(prepared, requested);
      if (prepared.phase === "committed") return this.#finishCommitted(prepared);

      const archive = buildAgentEventArchive({
        flowId: prepared.flowId,
        requestId: prepared.requestId,
        createdAt: prepared.createdAt,
        members: prepared.members,
      });
      assertFreshPreparation(prepared, archive);
      const manifest = manifestFromBuilt(archive);
      const publication = this.#files.publishImmutable({
        relativePath: archive.relativePath,
        bytes: archive.bytes,
      });
      publication.file.close();
      const pinned = this.#files.openPinned(archive.relativePath);
      try {
        verifyPinnedArchive({
          file: pinned,
          manifest,
          members: prepared.members,
          requestId: prepared.requestId,
        });
        this.#faultInjector?.("after_archive_segment_validation");
        pinned.assertCurrent();

        const archiveBody = {
          archiveId: archive.archiveId,
          flowId: archive.header.flowId,
          requestSha256: archive.requestSha256,
          relativePath: archive.relativePath,
          archiveSha256: archive.archiveSha256,
          merkleRootSha256: archive.merkleRootSha256,
          createdAt: archive.header.createdAt,
          firstSequence: archive.header.firstSequence,
          lastSequence: archive.header.lastSequence,
          members: prepared.members,
        };
        const deletionBody = {
          archiveId: archive.archiveId,
          flowId: archive.header.flowId,
          archiveSha256: archive.archiveSha256,
          merkleRootSha256: archive.merkleRootSha256,
          members: prepared.members,
        };
        const commitBody = { prepared, archive: archiveBody };
        const capability = this.#authority.issueCommitCapability({
          proof: {
            file: pinned,
            relativePath: archive.relativePath,
            archiveSha256: archive.archiveSha256,
            manifest,
            members: prepared.members,
            requestId: prepared.requestId,
          },
          commit: commitBody,
          deletion: deletionBody,
        });
        const commit = this.#store.commitArchiveManifest({
          capability,
          prepared,
          archive: archiveBody,
        });
        this.#faultInjector?.("after_archive_manifest_commit");
        verifyPinnedArchive({
          file: pinned,
          manifest,
          members: prepared.members,
          requestId: prepared.requestId,
        });
        this.#store.deleteArchivedPayloads({
          capability: commit.deletionCapability,
          ...deletionBody,
        });
        return {
          archiveId: archive.archiveId,
          archivePath: pinned.absolutePath,
          replayed: !publication.created || commit.replayed,
        };
      } finally {
        pinned.close();
      }
    });
  }

  readPayload(input: unknown): FlowTelemetryPayloadResult {
    const requested = payloadIdentity(input);
    return this.#files.withFlowLock(requested.flowId, () => {
      const resolved = this.#store.resolvePayload(requested);
      if (resolved.kind === "live") {
        const result = {
          payloadJson: resolved.payloadJson,
          payloadSha256: resolved.payloadSha256,
        };
        validateLivePayload(result);
        this.#store.verifyResolvedPayload({ ...requested, ...result });
        return result;
      }

      const file = this.#files.openPinned(resolved.manifest.relativePath);
      try {
        const verified = verifyPinnedArchive({
          file,
          manifest: manifestProjection(resolved.manifest),
          members: resolved.manifest.members,
        });
        const member = verified.members.find(({ eventId }) => eventId === resolved.targetEventId);
        if (member === undefined) throw new Error("archived telemetry payload has no durable member");
        file.assertCurrent();
        const result = { payloadJson: member.payloadJson, payloadSha256: member.payloadSha256 };
        this.#store.verifyResolvedPayload({ ...requested, ...result });
        return result;
      } finally {
        file.close();
      }
    });
  }

  #finishCommitted(prepared: CommittedArchivePreparation): FlowTelemetryArchiveResult {
    const file = this.#files.openPinned(prepared.relativePath);
    try {
      const manifest = manifestProjection(prepared);
      verifyPinnedArchive({
        file,
        manifest,
        members: prepared.members,
        requestId: prepared.requestId,
      });
      this.#faultInjector?.("after_archive_segment_validation");
      verifyPinnedArchive({
        file,
        manifest,
        members: prepared.members,
        requestId: prepared.requestId,
      });
      const deletionBody = {
        archiveId: prepared.archiveId,
        flowId: prepared.flowId,
        archiveSha256: prepared.archiveSha256,
        merkleRootSha256: prepared.merkleRootSha256,
        members: prepared.members,
      };
      const capability = this.#authority.issueRecoveryDeletionCapability({
        proof: {
          file,
          relativePath: prepared.relativePath,
          archiveSha256: prepared.archiveSha256,
          manifest,
          members: prepared.members,
          requestId: prepared.requestId,
        },
        deletion: deletionBody,
      });
      this.#store.deleteArchivedPayloads({
        capability,
        ...deletionBody,
      });
      return { archiveId: prepared.archiveId, archivePath: file.absolutePath, replayed: true };
    } finally {
      file.close();
    }
  }
}
