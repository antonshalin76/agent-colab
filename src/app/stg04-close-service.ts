import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { canonicalJson } from "../domain/canonical-json.js";
import {
  AMD_0001_AUTHORIZATION_TEXT,
  AMD_0001_AUTHORITY_FILE_SHA256,
  AMD_0001_FILE_SHA256,
  AMD_0001_ID,
  createAmendmentAcceptanceAuthority,
  type AmendmentAcceptanceCapability,
  type AmendmentCapabilityBinding,
} from "../flow/implementation-amendment.js";
import { createImplementationProgressAuthority } from "../flow/implementation-progress-authority.js";
import { openExistingStateLayout } from "../store/state-layout.js";
import { ImplementationProgressStore } from "../store/implementation-progress-store.js";
import { ImplementationProgressProjectionFiles } from "../store/implementation-progress-projection-files.js";
import { acquireStateOpenAdmission } from "../store/state-open-admission.js";
import type { StateDatabaseAccess } from "../store/state-database-fence.js";
import { ImplementationProgressService } from "./implementation-progress-service.js";
import { ImplementationProgressProjector } from "./implementation-progress-projector.js";
import {
  deriveStg04CloseState,
  type Stg04CloseObservation,
  type Stg04CloseState,
} from "./stg04-close-aggregate.js";

const PACKAGE_PATH = "docs/hybrid-flow-v1-r2";
const START_PATH = `${PACKAGE_PATH}/IMPLEMENTATION_START.json`;
const PLAN_LOCK_PATH = `${PACKAGE_PATH}/PLAN_LOCK.json`;
const STG03_PATH = `${PACKAGE_PATH}/stage-close/pre-v4/000004-stg-03-pass.json`;
const AMD_PATH = `${PACKAGE_PATH}/amendments/AMD-0001.json`;
const AMD_AUTHORITY_PATH = `${PACKAGE_PATH}/amendments/AMD-0001-authority.json`;
const SOURCE_BASELINE_HEAD = "d0f6cda738cf08ff851f14192ff48e636c1f0f17";
const TRUSTED_AMD_AUTHORITY = Object.freeze({
  schemaVersion: "trusted-amendment-authority/v1" as const,
  consumer: "agent-collab:implementation-amendment:AMD-0001",
  expectedReceiptSha256: "e5a76fdbc55a8b584bebaa842a958418a896853ffb5be08725c7abdccfacf1a3",
  authorizationTextSha256: "5afaede6548ebf2b62086bdda12eb54880e6a8681e6279915728fa71184db683",
});

interface ReviewedMigrationProcess {
  inspectExactOperation(): {
    readonly authorization: "absent" | "valid" | "invalid";
    readonly completion: "absent" | "valid" | "invalid";
  };
  migrateExactOperation(): Promise<unknown>;
}

interface RuntimeResources {
  readonly store: ImplementationProgressStore;
  readonly files: ImplementationProgressProjectionFiles;
  readonly service: ImplementationProgressService;
  readonly projector: ImplementationProgressProjector;
  readonly issueAmendment: (binding: AmendmentCapabilityBinding) => AmendmentAcceptanceCapability;
}

const parseObject = (bytes: Buffer, label: string): Record<string, unknown> => {
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
};

const schemaVersion = (path: string): number => {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try { return Number(database.pragma("user_version", { simple: true })); }
  finally { database.close(); }
};

export function createStg04CloseService(input: {
  readonly stateRoot: string;
  readonly repositoryRoot: string;
  readonly migration: ReviewedMigrationProcess;
  readonly openStateDatabaseAccess: () => StateDatabaseAccess;
  readonly faultInjector?: (point: string) => void;
}) {
  const layout = openExistingStateLayout(input.stateRoot);
  const repositoryRoot = resolve(input.repositoryRoot);
  const packageRoot = join(repositoryRoot, PACKAGE_PATH);
  let resources: RuntimeResources | undefined;
  let closed = false;
  const closeResources = (): void => {
    if (!resources) return;
    const current = resources;
    resources = undefined;
    try { current.projector.close(); }
    finally {
      try { current.files.close(); }
      finally { current.store.close(); }
    }
  };
  const readArtifact = (path: string): Buffer => readFileSync(join(repositoryRoot, path));
  const readProjection = () => {
    try {
      return {
        jsonl: readFileSync(join(packageRoot, "IMPLEMENTATION_PROGRESS.jsonl")),
        markdown: readFileSync(join(packageRoot, "IMPLEMENTATION_PROGRESS.md")),
      };
    } catch { return {}; }
  };
  const getResources = (): RuntimeResources => {
    if (closed) throw new Error("STG-04 close service is closed");
    if (resources) return resources;
    const progressAuthority = createImplementationProgressAuthority();
    const amendmentAuthority = createAmendmentAcceptanceAuthority(TRUSTED_AMD_AUTHORITY);
    const store = new ImplementationProgressStore(input.openStateDatabaseAccess(), {
      progressAuthority: progressAuthority.store,
      amendmentAuthority: amendmentAuthority.store,
      ...(input.faultInjector ? { faultInjector: input.faultInjector } : {}),
    });
    const files = new ImplementationProgressProjectionFiles({
      packageRoot,
      stateRoot: layout.root,
      ...(input.faultInjector ? { faultInjector: input.faultInjector } : {}),
    });
    const service = new ImplementationProgressService({
      store,
      databasePath: layout.database,
      readArtifact,
      readProjection,
      sourceFacts: {
        start: parseObject(readArtifact(START_PATH), "implementation start"),
        planLock: parseObject(readArtifact(PLAN_LOCK_PATH), "implementation plan lock"),
        planAnchorParent: SOURCE_BASELINE_HEAD,
      },
      progressVerifier: progressAuthority.verifier,
      amendmentAuthority: amendmentAuthority.service,
    });
    resources = {
      store,
      files,
      service,
      projector: new ImplementationProgressProjector({
        store,
        files,
        stateRoot: layout.root,
        ...(input.faultInjector ? { faultInjector: input.faultInjector } : {}),
      }),
      issueAmendment: amendmentAuthority.issuer.issue,
    };
    return resources;
  };
  const observe = (): Stg04CloseObservation => {
    const admission = acquireStateOpenAdmission(layout.root, "shared");
    try {
      admission.assertCurrent();
      const stateVersion = schemaVersion(layout.database);
      const historyVersion = schemaVersion(layout.historyDatabase);
      let migrationAuthorization: Stg04CloseObservation["migrationAuthorization"] = "invalid";
      let migrationCompletion: Stg04CloseObservation["migrationCompletion"] = "invalid";
      try {
        const inspection = input.migration.inspectExactOperation();
        migrationAuthorization = inspection.authorization;
        migrationCompletion = inspection.completion;
      } catch { /* invalid is the fail-closed observation */ }
      if (stateVersion !== 4) {
        return {
          stateVersion,
          historyVersion,
          migrationAuthorization,
          migrationCompletion,
          progressSequence: 0,
          amdAcceptance: "absent",
          projection: "absent",
          projectionWatermarkSequence: null,
          review: "absent",
        };
      }
      if (migrationAuthorization !== "valid" || migrationCompletion !== "valid") {
        return {
          stateVersion,
          historyVersion,
          migrationAuthorization,
          migrationCompletion,
          progressSequence: 0,
          amdAcceptance: "absent",
          projection: "absent",
          projectionWatermarkSequence: null,
          review: "absent",
        };
      }
      try {
        const current = getResources();
        const verification = current.service.verify();
        const snapshot = current.store.snapshotProjection();
        return {
          stateVersion,
          historyVersion,
          migrationAuthorization,
          migrationCompletion,
          progressSequence: verification.progressEventCount,
          amdAcceptance: verification.progressEventCount === 5 ? "partial"
            : verification.progressEventCount >= 6 ? "accepted" : "absent",
          projection: verification.projectionStatus,
          projectionWatermarkSequence: verification.projectionStatus === "current" ? snapshot.watermarkSequence : null,
          review: "absent",
        };
      } catch {
        return {
          stateVersion,
          historyVersion,
          migrationAuthorization,
          migrationCompletion,
          progressSequence: 0,
          amdAcceptance: "invalid",
          projection: "invalid",
          projectionWatermarkSequence: null,
          review: "absent",
        };
      }
    } finally {
      admission.release();
    }
  };
  return Object.freeze({
    status(): Stg04CloseState {
      if (closed) throw new Error("STG-04 close service is closed");
      return deriveStg04CloseState(observe());
    },
    async prepare(request: { readonly acceptedAt: number; readonly publishedAt: number }) {
      if (closed) throw new Error("STG-04 close service is closed");
      const keys = Object.keys(request).sort();
      if (canonicalJson(keys) !== canonicalJson(["acceptedAt", "publishedAt"].sort())) {
        throw new Error("STG-04 close input contains an unknown field or trusted anchor");
      }
      if (!Number.isSafeInteger(request.acceptedAt) || !Number.isSafeInteger(request.publishedAt) ||
          request.publishedAt < request.acceptedAt) {
        throw new Error("STG-04 close input is invalid");
      }
      closeResources();
      await input.migration.migrateExactOperation();
      const current = getResources();
      const stage = parseObject(readArtifact(STG03_PATH), "STG-03 close event");
      current.service.appendEvent({ event: stage, eventJson: canonicalJson(stage) });
      const binding = {
        databasePath: layout.database,
        amendmentId: AMD_0001_ID,
        amendmentPath: AMD_PATH,
        amendmentFileSha256: AMD_0001_FILE_SHA256,
        authorityReceiptPath: AMD_AUTHORITY_PATH,
        authorityReceiptFileSha256: AMD_0001_AUTHORITY_FILE_SHA256,
      } as const;
      current.service.acceptAmendment({
        amendmentPath: AMD_PATH,
        authorityReceiptPath: AMD_AUTHORITY_PATH,
        authorizationTextBytes: Buffer.from(AMD_0001_AUTHORIZATION_TEXT, "utf8"),
        acceptedAt: request.acceptedAt,
      }, current.issueAmendment(binding));
      current.projector.project({ publishedAt: request.publishedAt });
      return deriveStg04CloseState(observe());
    },
    close(): void {
      if (closed) return;
      closed = true;
      closeResources();
    },
  });
}
