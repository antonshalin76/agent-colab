import { isDeepStrictEqual } from "node:util";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalJson, computeBytesSha256 } from "../domain/canonical-json.js";
import {
  verifyStoredAgentEventArchive,
  type AgentEventArchiveManifestProjection,
  type AgentEventArchiveMemberProjection,
} from "../runtime/flow-telemetry-archive.js";
import {
  assertAuthenticPinnedStateFile,
  type PinnedStateFile,
} from "../store/state-file-durability.js";

declare const commitCapabilityBrand: unique symbol;
declare const deletionCapabilityBrand: unique symbol;

export interface ArchiveCommitCapability {
  readonly [commitCapabilityBrand]: true;
}

export interface ArchiveDeletionCapability {
  readonly [deletionCapabilityBrand]: true;
}

export interface ArchiveAuthorityFileProof {
  readonly file: PinnedStateFile;
  readonly relativePath: string;
  readonly archiveSha256: string;
  readonly manifest: AgentEventArchiveManifestProjection;
  readonly members: readonly AgentEventArchiveMemberProjection[];
  readonly requestId?: string;
}

export interface ArchiveCommitAuthorityInput {
  readonly prepared: unknown;
  readonly archive: unknown;
}

export interface ArchiveDeletionAuthorityInput {
  readonly archiveId: string;
  readonly flowId: string;
  readonly archiveSha256: string;
  readonly merkleRootSha256: string;
  readonly members: readonly unknown[];
}

export interface FlowTelemetryArchiveServiceAuthorityPort {
  issueCommitCapability(input: {
    readonly proof: ArchiveAuthorityFileProof;
    readonly commit: ArchiveCommitAuthorityInput;
    readonly deletion: ArchiveDeletionAuthorityInput;
  }): ArchiveCommitCapability;
  issueRecoveryDeletionCapability(input: {
    readonly proof: ArchiveAuthorityFileProof;
    readonly deletion: ArchiveDeletionAuthorityInput;
  }): ArchiveDeletionCapability;
}

export interface FlowTelemetryArchiveStoreAuthorityPort {
  bindStore(store: object, stateRoot: string): void;
  claimCommitCapability(input: {
    readonly store: object;
    readonly capability: ArchiveCommitCapability;
    readonly commit: ArchiveCommitAuthorityInput;
  }): {
    assertCurrent(): void;
    complete(): ArchiveDeletionCapability;
    abort(): void;
  };
  claimDeletionCapability(input: {
    readonly store: object;
    readonly capability: ArchiveDeletionCapability;
    readonly deletion: ArchiveDeletionAuthorityInput;
  }): {
    assertCurrent(): void;
    complete(): void;
    abort(): void;
  };
}

interface FileBinding {
  readonly file: PinnedStateFile;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly archiveSha256: string;
  readonly manifest: AgentEventArchiveManifestProjection;
  readonly members: readonly AgentEventArchiveMemberProjection[];
  readonly requestId: string | undefined;
}

interface CommitGrant {
  readonly store: object;
  readonly file: FileBinding;
  readonly commitSha256: string;
  readonly deletion: ArchiveDeletionAuthorityInput;
  status: "ready" | "claimed" | "consumed";
}

interface DeletionGrant {
  readonly store: object;
  readonly file: FileBinding;
  readonly deletionSha256: string;
  status: "ready" | "claimed" | "consumed";
}

const authenticStorePorts = new WeakSet<object>();

function capability(): object {
  return Object.freeze(Object.create(null) as object);
}

function exactBodySha256(value: unknown): string {
  return computeBytesSha256(canonicalJson(value));
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function memberProjection(value: unknown): AgentEventArchiveMemberProjection {
  const member = objectValue(value, "archive authority member");
  return {
    eventId: String(member.eventId),
    sequenceNo: Number(member.sequenceNo),
    eventSha256: String(member.eventSha256),
    payloadSha256: String(member.payloadSha256),
  };
}

function assertProofMatchesBodies(input: {
  readonly proof: ArchiveAuthorityFileProof;
  readonly commit?: ArchiveCommitAuthorityInput;
  readonly deletion: ArchiveDeletionAuthorityInput;
}): void {
  const { manifest } = input.proof;
  const proofMembers = input.proof.members.map(memberProjection);
  const deletionMembers = input.deletion.members.map(memberProjection);
  if (input.proof.relativePath !== manifest.relativePath ||
      input.proof.archiveSha256 !== manifest.archiveSha256 ||
      input.deletion.archiveId !== manifest.archiveId ||
      input.deletion.flowId !== manifest.flowId ||
      input.deletion.archiveSha256 !== manifest.archiveSha256 ||
      input.deletion.merkleRootSha256 !== manifest.merkleRootSha256 ||
      !isDeepStrictEqual(deletionMembers, proofMembers)) {
    throw new Error("archive authority proof conflicts with the exact deletion body or manifest");
  }
  if (input.commit === undefined) return;
  const archive = objectValue(input.commit.archive, "archive commit body");
  const prepared = objectValue(input.commit.prepared, "archive preparation body");
  const commitMembers = Array.isArray(archive.members) ? archive.members.map(memberProjection) : [];
  if (archive.archiveId !== manifest.archiveId || archive.flowId !== manifest.flowId ||
      archive.relativePath !== manifest.relativePath || archive.archiveSha256 !== manifest.archiveSha256 ||
      archive.merkleRootSha256 !== manifest.merkleRootSha256 ||
      archive.firstSequence !== manifest.firstSequence || archive.lastSequence !== manifest.lastSequence ||
      archive.createdAt !== manifest.createdAt || prepared.requestId !== input.proof.requestId ||
      !isDeepStrictEqual(commitMembers, proofMembers)) {
    throw new Error("archive authority proof conflicts with the exact commit body or manifest");
  }
}

function assertRelativePath(value: string): void {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value) || value.includes("\\") ||
      value.split("/").some((component) => component.length === 0 || component === "." || component === "..")) {
    throw new Error("archive authority relative path is invalid");
  }
}

function rootFor(absolutePath: string, relativePath: string): string {
  assertRelativePath(relativePath);
  const absolute = resolve(absolutePath);
  const segments = relativePath.split("/");
  let root = absolute;
  for (let index = 0; index < segments.length; index += 1) root = resolve(root, "..");
  const rel = relative(root, absolute);
  if (rel !== relativePath.split("/").join(sep) || resolve(root, relativePath) !== absolute) {
    throw new Error("archive authority file path is outside its exact root binding");
  }
  return root;
}

function verifyFile(
  proof: ArchiveAuthorityFileProof,
  expectedRoot: string | undefined,
): { readonly binding: FileBinding; readonly root: string } {
  assertAuthenticPinnedStateFile(proof.file);
  const root = rootFor(proof.file.absolutePath, proof.relativePath);
  if (expectedRoot !== undefined && root !== expectedRoot) {
    throw new Error("archive authority file belongs to another state root");
  }
  proof.file.assertCurrent();
  const bytes = proof.file.read();
  if (computeBytesSha256(bytes) !== proof.archiveSha256) {
    throw new Error("archive authority pinned file digest differs from the exact published body");
  }
  verifyStoredAgentEventArchive({
    bytes,
    manifest: proof.manifest,
    members: proof.members,
    ...(proof.requestId === undefined ? {} : { requestId: proof.requestId }),
  });
  proof.file.assertCurrent();
  return {
    root,
    binding: {
      file: proof.file,
      absolutePath: proof.file.absolutePath,
      relativePath: proof.relativePath,
      archiveSha256: proof.archiveSha256,
      manifest: proof.manifest,
      members: proof.members,
      requestId: proof.requestId,
    },
  };
}

function reverifyFile(binding: FileBinding, root: string): void {
  const verified = verifyFile({
    file: binding.file,
    relativePath: binding.relativePath,
    archiveSha256: binding.archiveSha256,
    manifest: binding.manifest,
    members: binding.members,
    ...(binding.requestId === undefined ? {} : { requestId: binding.requestId }),
  }, root);
  if (verified.binding.absolutePath !== binding.absolutePath) {
    throw new Error("archive authority pinned file path changed");
  }
}

export function assertFlowTelemetryArchiveStoreAuthorityPort(
  port: FlowTelemetryArchiveStoreAuthorityPort,
): void {
  if (!authenticStorePorts.has(port as object)) {
    throw new Error("archive store authority port is not authentic");
  }
}

export function createFlowTelemetryArchiveAuthority(): {
  readonly service: FlowTelemetryArchiveServiceAuthorityPort;
  readonly store: FlowTelemetryArchiveStoreAuthorityPort;
} {
  let boundStore: object | undefined;
  let boundRoot: string | undefined;
  const commits = new WeakMap<object, CommitGrant>();
  const deletions = new WeakMap<object, DeletionGrant>();

  const bindFile = (proof: ArchiveAuthorityFileProof): FileBinding => {
    if (boundStore === undefined) throw new Error("archive authority has no bound telemetry store");
    const verified = verifyFile(proof, boundRoot);
    return verified.binding;
  };

  const newDeletionCapability = (
    store: object,
    file: FileBinding,
    deletion: ArchiveDeletionAuthorityInput,
  ): ArchiveDeletionCapability => {
    const token = capability() as ArchiveDeletionCapability;
    deletions.set(token, {
      store,
      file,
      deletionSha256: exactBodySha256(deletion),
      status: "ready",
    });
    return token;
  };

  const storePort: FlowTelemetryArchiveStoreAuthorityPort = Object.freeze({
    bindStore(store: object, stateRoot: string): void {
      const canonicalRoot = resolve(stateRoot);
      if (canonicalRoot !== stateRoot) {
        throw new Error("archive authority state root must be canonical");
      }
      if (boundStore !== undefined && boundStore !== store) {
        throw new Error("archive authority is already bound to another telemetry store");
      }
      if (boundRoot !== undefined && boundRoot !== canonicalRoot) {
        throw new Error("archive authority is already bound to another state root");
      }
      boundStore = store;
      boundRoot = canonicalRoot;
    },
    claimCommitCapability(input: {
      readonly store: object;
      readonly capability: ArchiveCommitCapability;
      readonly commit: ArchiveCommitAuthorityInput;
    }): ReturnType<FlowTelemetryArchiveStoreAuthorityPort["claimCommitCapability"]> {
      const grant = commits.get(input.capability as object);
      if (!grant || grant.store !== input.store || input.store !== boundStore) {
        throw new Error("archive commit capability was not issued for this store");
      }
      if (grant.status !== "ready") throw new Error("archive commit capability was already consumed or claimed");
      if (grant.commitSha256 !== exactBodySha256(input.commit)) {
        throw new Error("archive commit capability does not authorize this exact body");
      }
      reverifyFile(grant.file, boundRoot!);
      grant.status = "claimed";
      let settled = false;
      return Object.freeze({
        assertCurrent() {
          if (settled || grant.status !== "claimed") throw new Error("archive commit capability claim is not active");
          reverifyFile(grant.file, boundRoot!);
        },
        complete() {
          if (settled || grant.status !== "claimed") throw new Error("archive commit capability claim is not active");
          settled = true;
          grant.status = "consumed";
          return newDeletionCapability(grant.store, grant.file, grant.deletion);
        },
        abort() {
          if (settled) return;
          settled = true;
          if (grant.status === "claimed") grant.status = "ready";
        },
      });
    },
    claimDeletionCapability(input: {
      readonly store: object;
      readonly capability: ArchiveDeletionCapability;
      readonly deletion: ArchiveDeletionAuthorityInput;
    }): ReturnType<FlowTelemetryArchiveStoreAuthorityPort["claimDeletionCapability"]> {
      const grant = deletions.get(input.capability as object);
      if (!grant || grant.store !== input.store || input.store !== boundStore) {
        throw new Error("archive deletion capability was not issued for this store");
      }
      if (grant.status !== "ready") throw new Error("archive deletion capability was already consumed or claimed");
      if (grant.deletionSha256 !== exactBodySha256(input.deletion)) {
        throw new Error("archive deletion capability does not authorize this exact body");
      }
      reverifyFile(grant.file, boundRoot!);
      grant.status = "claimed";
      let settled = false;
      return Object.freeze({
        assertCurrent() {
          if (settled || grant.status !== "claimed") throw new Error("archive deletion capability claim is not active");
          reverifyFile(grant.file, boundRoot!);
        },
        complete() {
          if (settled || grant.status !== "claimed") throw new Error("archive deletion capability claim is not active");
          settled = true;
          grant.status = "consumed";
        },
        abort() {
          if (settled) return;
          settled = true;
          if (grant.status === "claimed") grant.status = "ready";
        },
      });
    },
  });
  authenticStorePorts.add(storePort);

  const servicePort: FlowTelemetryArchiveServiceAuthorityPort = Object.freeze({
    issueCommitCapability(input: {
      readonly proof: ArchiveAuthorityFileProof;
      readonly commit: ArchiveCommitAuthorityInput;
      readonly deletion: ArchiveDeletionAuthorityInput;
    }): ArchiveCommitCapability {
      const store = boundStore;
      if (store === undefined) throw new Error("archive authority has no bound telemetry store");
      assertProofMatchesBodies(input);
      const file = bindFile(input.proof);
      const token = capability() as ArchiveCommitCapability;
      commits.set(token, {
        store,
        file,
        commitSha256: exactBodySha256(input.commit),
        deletion: input.deletion,
        status: "ready",
      });
      return token;
    },
    issueRecoveryDeletionCapability(input: {
      readonly proof: ArchiveAuthorityFileProof;
      readonly deletion: ArchiveDeletionAuthorityInput;
    }): ArchiveDeletionCapability {
      const store = boundStore;
      if (store === undefined) throw new Error("archive authority has no bound telemetry store");
      assertProofMatchesBodies(input);
      const file = bindFile(input.proof);
      return newDeletionCapability(store, file, input.deletion);
    },
  });

  return Object.freeze({ service: servicePort, store: storePort });
}
