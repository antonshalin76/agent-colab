import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson } from "../workflow/flow-contract.js";
import { StateV4RestoreGuard, type StateV4GuardEvent, type StateV4GuardRecord } from "./operational-restore.js";

export interface ActiveStateV4GuardDescriptor {
  schemaVersion: "active-state-v4-restore-guard/v1";
  databaseIdentity: string;
  backupSha256: string;
  tableDigestManifestSha256: string;
  writeEpoch: string;
  backupPath: string;
  tableDigestManifestPath: string;
  guardPath: string;
  descriptorSha256: string;
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const fsyncPath = (path: string): void => {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
};

export const activeStateV4GuardDescriptor = (
  input: Omit<ActiveStateV4GuardDescriptor, "schemaVersion" | "descriptorSha256">,
): ActiveStateV4GuardDescriptor => {
  const base = { schemaVersion: "active-state-v4-restore-guard/v1" as const, ...input };
  return { ...base, descriptorSha256: sha256(canonicalJson(base)) };
};

export const stateV4ActiveDescriptorPath = (stateRoot: string): string =>
  resolve(stateRoot, "migration-v4/active-restore-guard.json");

const operationalArtifactPath = (stateRoot: string, operationRoot: string, path: string): string => {
  const rel = relative(resolve(stateRoot), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("state-v4 artifact path is outside its authority root");
  }
  return join(operationRoot, rel);
};

const assertDescriptorBytes = (bytes: string): ActiveStateV4GuardDescriptor => {
  if (!bytes.endsWith("\n")) throw new Error("active state-v4 restore-guard descriptor is truncated");
  const descriptor = JSON.parse(bytes) as ActiveStateV4GuardDescriptor;
  const expected = activeStateV4GuardDescriptor({
    databaseIdentity: descriptor.databaseIdentity,
    backupSha256: descriptor.backupSha256,
    tableDigestManifestSha256: descriptor.tableDigestManifestSha256,
    writeEpoch: descriptor.writeEpoch,
    backupPath: descriptor.backupPath,
    tableDigestManifestPath: descriptor.tableDigestManifestPath,
    guardPath: descriptor.guardPath,
  });
  if (`${canonicalJson(descriptor)}\n` !== bytes || descriptor.schemaVersion !== expected.schemaVersion ||
      descriptor.descriptorSha256 !== expected.descriptorSha256) {
    throw new Error("active state-v4 restore-guard descriptor hash or canonical bytes mismatch");
  }
  return descriptor;
};

const assertDescriptorArtifactPaths = (
  stateRoot: string,
  descriptor: ActiveStateV4GuardDescriptor,
): ActiveStateV4GuardDescriptor => {
  const expectedGuard = resolve(stateRoot, "migration-guard", `state-v4-${descriptor.backupSha256}.jsonl`);
  if (resolve(descriptor.guardPath) !== expectedGuard ||
      resolve(descriptor.tableDigestManifestPath) !== `${resolve(descriptor.backupPath)}.manifest.json`) {
    throw new Error("state-v4 descriptor artifact paths are not canonical");
  }
  return descriptor;
};

export function readActiveStateV4GuardDescriptor(
  stateRoot: string,
  operationRoot = stateRoot,
): ActiveStateV4GuardDescriptor | undefined {
  const path = stateV4ActiveDescriptorPath(operationRoot);
  if (existsSync(`${path}.pending`) || existsSync(`${path}.tmp`)) {
    throw new Error("active state-v4 restore-guard descriptor has an interrupted durable write");
  }
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("active state-v4 restore-guard descriptor must be one regular file");
  }
  return assertDescriptorArtifactPaths(stateRoot, assertDescriptorBytes(readFileSync(path, "utf8")));
}

type StateV4RestoreReceiptAuthority = Pick<ActiveStateV4GuardDescriptor,
  "databaseIdentity" | "backupSha256" | "tableDigestManifestSha256" | "writeEpoch" |
  "backupPath" | "tableDigestManifestPath" | "guardPath">;

const receiptMatchesDescriptor = (
  receipt: StateV4RestoreReceiptAuthority,
  descriptor: ActiveStateV4GuardDescriptor,
): boolean => receipt.databaseIdentity === descriptor.databaseIdentity &&
  receipt.backupSha256 === descriptor.backupSha256 &&
  receipt.tableDigestManifestSha256 === descriptor.tableDigestManifestSha256 &&
  receipt.writeEpoch === descriptor.writeEpoch &&
  resolve(receipt.backupPath) === resolve(descriptor.backupPath) &&
  resolve(receipt.tableDigestManifestPath) === resolve(descriptor.tableDigestManifestPath) &&
  resolve(receipt.guardPath) === resolve(descriptor.guardPath);

export function requireStateV4RestoreAuthority(
  stateRoot: string,
  receipt: StateV4RestoreReceiptAuthority,
  operationRoot = stateRoot,
): ActiveStateV4GuardDescriptor {
  const active = readActiveStateV4GuardDescriptor(stateRoot, operationRoot);
  if (active) {
    if (!receiptMatchesDescriptor(receipt, active)) {
      throw new Error("state-v4 restore receipt does not match the active authority generation");
    }
    const marker = resolve(operationRoot, "migration-v4/retirement.pending");
    if (existsSync(marker)) {
      const bytes = readFileSync(marker, "utf8");
      if (!/^[a-f0-9]{64}\n$/.test(bytes) || bytes.trim() !== active.descriptorSha256) {
        throw new Error("state-v4 retirement marker conflicts with the active authority generation");
      }
      const retiredPath = resolve(retiredDirectory(operationRoot), `${active.descriptorSha256}.json`);
      if (existsSync(retiredPath)) {
        const retiring = assertDescriptorArtifactPaths(
          stateRoot,
          assertDescriptorBytes(readFileSync(retiredPath, "utf8")),
        );
        if (retiring.descriptorSha256 !== active.descriptorSha256) {
          throw new Error("state-v4 retiring descriptor conflicts with the active authority generation");
        }
      }
    }
    return active;
  }
  const marker = resolve(operationRoot, "migration-v4/retirement.pending");
  let candidates: ActiveStateV4GuardDescriptor[];
  if (existsSync(marker)) {
    const bytes = readFileSync(marker, "utf8");
    if (!/^[a-f0-9]{64}\n$/.test(bytes)) throw new Error("state-v4 retirement marker is malformed");
    const path = resolve(retiredDirectory(operationRoot), `${bytes.trim()}.json`);
    if (!existsSync(path)) throw new Error("state-v4 retiring authority descriptor is missing");
    candidates = [assertDescriptorArtifactPaths(stateRoot, assertDescriptorBytes(readFileSync(path, "utf8")))];
  } else {
    candidates = retiredStateV4Descriptors(stateRoot, operationRoot);
  }
  const matching = candidates.filter((descriptor) => receiptMatchesDescriptor(receipt, descriptor));
  if (matching.length !== 1) {
    throw new Error("state-v4 restore receipt has no unique durable authority generation");
  }
  return matching[0]!;
}

export function writeActiveStateV4GuardDescriptor(
  stateRoot: string,
  descriptor: ActiveStateV4GuardDescriptor,
): void {
  const path = stateV4ActiveDescriptorPath(stateRoot);
  const temporary = `${path}.tmp`;
  const pending = `${path}.pending`;
  if (existsSync(path) || existsSync(temporary) || existsSync(pending)) {
    throw new Error("active state-v4 restore-guard descriptor already exists or is interrupted");
  }
  writeFileSync(pending, `${descriptor.descriptorSha256}\n`, { mode: 0o600, flag: "wx" });
  fsyncPath(pending);
  fsyncPath(dirname(path));
  writeFileSync(temporary, `${canonicalJson(descriptor)}\n`, { mode: 0o600, flag: "wx" });
  fsyncPath(temporary);
  renameSync(temporary, path);
  fsyncPath(dirname(path));
  rmSync(pending);
  fsyncPath(dirname(path));
}

export type StateV4OpenAdmission = "inactive" | "active" | "restore_consumed";

export function assertPhysicalRestoreAllowed(
  descriptor: Pick<ActiveStateV4GuardDescriptor, "writeEpoch" | "tableDigestManifestSha256">,
  records: readonly StateV4GuardRecord[],
  expected: { writeEpoch?: string; tableDigestManifestSha256?: string } = {},
): StateV4GuardRecord {
  if (records.length !== 1 || records[0]?.event !== "backup_created") {
    throw new Error("physical restore is forbidden after reopen, write admission, or prior restore");
  }
  if (expected.writeEpoch !== undefined && expected.writeEpoch !== descriptor.writeEpoch) {
    throw new Error("physical restore write epoch changed");
  }
  if (expected.tableDigestManifestSha256 !== undefined &&
      expected.tableDigestManifestSha256 !== descriptor.tableDigestManifestSha256) {
    throw new Error("physical restore table manifest changed");
  }
  return records[0];
}

export function inspectStateV4OpenAdmission(
  stateRoot: string,
  operationRoot = stateRoot,
): StateV4OpenAdmission {
  const descriptor = readActiveStateV4GuardDescriptor(stateRoot, operationRoot);
  if (!descriptor) {
    assertNoInterruptedRetirement(stateRoot, operationRoot);
    return "inactive";
  }
  const guard = new StateV4RestoreGuard({
    journalPath: operationalArtifactPath(stateRoot, operationRoot, descriptor.guardPath),
    databaseIdentity: descriptor.databaseIdentity,
    backupSha256: descriptor.backupSha256,
    tableDigestManifestSha256: descriptor.tableDigestManifestSha256,
    writeEpoch: descriptor.writeEpoch,
  });
  return guard.readAndVerify().at(-1)?.event === "restore_consumed" ? "restore_consumed" : "active";
}

export function appendStateV4GuardEvent(
  stateRoot: string,
  event: Extract<StateV4GuardEvent, "service_reopened" | "mutable_write_admitted">,
  recordedAt = Date.now(),
  operationRoot = stateRoot,
): StateV4OpenAdmission {
  const descriptor = readActiveStateV4GuardDescriptor(stateRoot, operationRoot);
  if (!descriptor) { assertNoInterruptedRetirement(stateRoot, operationRoot); return "inactive"; }
  const guard = new StateV4RestoreGuard({
    journalPath: operationalArtifactPath(stateRoot, operationRoot, descriptor.guardPath),
    databaseIdentity: descriptor.databaseIdentity,
    backupSha256: descriptor.backupSha256,
    tableDigestManifestSha256: descriptor.tableDigestManifestSha256,
    writeEpoch: descriptor.writeEpoch,
  });
  const records = guard.readAndVerify();
  if (records.at(-1)?.event === "restore_consumed") return "restore_consumed";
  if (records.at(-1)?.event !== event) guard.append(event, recordedAt);
  return "active";
}

const retiredDirectory = (stateRoot: string): string => resolve(stateRoot, "migration-v4/retired");

export function assertNoInterruptedRetirement(stateRoot: string, operationRoot = stateRoot): void {
  if (existsSync(resolve(operationRoot, "migration-v4/retirement.pending"))) {
    throw new Error("state-v4 descriptor retirement is incomplete");
  }
  const directory = retiredDirectory(operationRoot);
  if (!existsSync(directory)) return;
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
    throw new Error("state-v4 retirement evidence directory is invalid");
  }
  const interrupted = readdirSync(directory).filter((name) => name.endsWith(".tmp") || name.endsWith(".pending"));
  if (interrupted.length > 0) throw new Error("state-v4 descriptor retirement is incomplete");
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
    const path = resolve(directory, name);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).nlink !== 1) {
      throw new Error("state-v4 retired descriptor evidence is invalid");
    }
    const descriptor = assertDescriptorBytes(readFileSync(path, "utf8"));
    if (name !== `${descriptor.descriptorSha256}.json`) {
      throw new Error("state-v4 retired descriptor identity mismatch");
    }
  }
}

export function retiredStateV4Descriptors(
  stateRoot: string,
  operationRoot = stateRoot,
): ActiveStateV4GuardDescriptor[] {
  assertNoInterruptedRetirement(stateRoot, operationRoot);
  const directory = retiredDirectory(operationRoot);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith(".json")).sort()
    .map((name) => assertDescriptorArtifactPaths(
      stateRoot,
      assertDescriptorBytes(readFileSync(resolve(directory, name), "utf8")),
    ));
}

export function retireConsumedStateV4Descriptor(
  stateRoot: string,
  faultInjector?: (point: "after_v4_retired_descriptor_rename" | "after_v4_retired_directory_fsync" |
    "after_v4_active_descriptor_removed" | "after_v4_active_descriptor_directory_fsync" |
    "after_v4_retirement_marker_removed" | "after_v4_retirement_marker_directory_fsync") => void,
  operationRoot = stateRoot,
): ActiveStateV4GuardDescriptor {
  const migrationRoot = resolve(operationRoot, "migration-v4");
  const marker = resolve(migrationRoot, "retirement.pending");
  const active = readActiveStateV4GuardDescriptor(stateRoot, operationRoot);
  let markerSha: string | undefined;
  if (existsSync(marker)) {
    const bytes = readFileSync(marker, "utf8");
    if (!/^[a-f0-9]{64}\n$/.test(bytes)) throw new Error("state-v4 retirement marker is malformed");
    markerSha = bytes.trim();
  }
  const retired = retiredDirectory(operationRoot);
  const retiredPath = markerSha ? resolve(retired, `${markerSha}.json`) : undefined;
  const descriptor = active ?? (retiredPath && existsSync(retiredPath)
    ? assertDescriptorArtifactPaths(stateRoot, assertDescriptorBytes(readFileSync(retiredPath, "utf8"))) : undefined);
  if (!descriptor) throw new Error("state-v4 consumed retirement authority is missing");
  if (markerSha && markerSha !== descriptor.descriptorSha256) {
    throw new Error("state-v4 retirement marker conflicts with descriptor generation");
  }
  const guard = new StateV4RestoreGuard({
    journalPath: operationalArtifactPath(stateRoot, operationRoot, descriptor.guardPath),
    databaseIdentity: descriptor.databaseIdentity,
    backupSha256: descriptor.backupSha256,
    tableDigestManifestSha256: descriptor.tableDigestManifestSha256,
    writeEpoch: descriptor.writeEpoch,
  });
  if (guard.readAndVerify().at(-1)?.event !== "restore_consumed") {
    throw new Error("only a consumed state-v4 descriptor may retire");
  }
  const directory = retired;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = resolve(directory, `${descriptor.descriptorSha256}.json`);
  const temporary = `${target}.tmp`;
  const activePath = stateV4ActiveDescriptorPath(operationRoot);
  const activeBytes = Buffer.from(`${canonicalJson(descriptor)}\n`);
  if (!existsSync(marker)) {
    writeFileSync(marker, `${descriptor.descriptorSha256}\n`, { mode: 0o600, flag: "wx" });
    fsyncPath(marker);
    fsyncPath(migrationRoot);
  }
  if (existsSync(target)) {
    if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink() ||
        !readFileSync(target).equals(activeBytes)) {
      throw new Error("state-v4 retired descriptor generation conflicts with active authority");
    }
  } else {
    if (existsSync(temporary)) {
      if (!lstatSync(temporary).isFile() || lstatSync(temporary).isSymbolicLink() ||
          !readFileSync(temporary).equals(activeBytes)) {
        throw new Error("state-v4 descriptor retirement requires operator reconciliation");
      }
    } else {
      writeFileSync(temporary, activeBytes, { mode: 0o400, flag: "wx" });
      fsyncPath(temporary);
    }
    renameSync(temporary, target);
  }
  faultInjector?.("after_v4_retired_descriptor_rename");
  fsyncPath(directory);
  faultInjector?.("after_v4_retired_directory_fsync");
  rmSync(activePath, { force: true });
  faultInjector?.("after_v4_active_descriptor_removed");
  fsyncPath(dirname(activePath));
  faultInjector?.("after_v4_active_descriptor_directory_fsync");
  rmSync(marker);
  faultInjector?.("after_v4_retirement_marker_removed");
  fsyncPath(migrationRoot);
  faultInjector?.("after_v4_retirement_marker_directory_fsync");
  return descriptor;
}
