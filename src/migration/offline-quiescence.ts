import { resolve } from "node:path";

export interface OfflineDatabasePair {
  readonly stateDatabase: string;
  readonly historyDatabase: string;
}

export interface OfflineProcessScan {
  readonly files: ReadonlyArray<{
    readonly pid: number;
    readonly path: string;
    readonly dev: number;
    readonly ino: number;
  }>;
  readonly unreadableSameUidPids: readonly number[];
}

export interface OfflineQuiescencePorts {
  serviceState(): "active" | "inactive" | "unknown";
  scanSameUidOpenFiles(): OfflineProcessScan;
  stat(path: string): { readonly dev: number; readonly ino: number };
  acquireFence(): { assertCurrent(): void; release(): void };
}

export interface OfflineMigrationQuiescence {
  assertServiceInactive(input: OfflineDatabasePair): void;
  assertNoOpenDatabaseFds(input: OfflineDatabasePair): void;
  acquireExclusiveWriteFence(input: OfflineDatabasePair): { assertCurrent(): void; release(): void };
}

const sqlitePaths = (pair: OfflineDatabasePair): ReadonlySet<string> => new Set(
  [pair.stateDatabase, pair.historyDatabase].flatMap((path) => {
    const canonical = resolve(path);
    return [canonical, `${canonical}-wal`, `${canonical}-shm`, `${canonical}-journal`];
  }),
);

const procPath = (path: string): string => resolve(path.endsWith(" (deleted)") ? path.slice(0, -10) : path);

export function createOfflineMigrationQuiescence(
  ports: OfflineQuiescencePorts,
): OfflineMigrationQuiescence {
  const assertServiceInactive = (_input: OfflineDatabasePair): void => {
    const state = ports.serviceState();
    if (state !== "inactive") {
      throw new Error(`managed service must be inactive for offline migration; observed ${state}`);
    }
  };
  const assertNoOpenDatabaseFds = (input: OfflineDatabasePair): void => {
    const scan = ports.scanSameUidOpenFiles();
    if (scan.unreadableSameUidPids.length > 0) {
      throw new Error("same-UID /proc descriptor scan is incomplete or unreadable");
    }
    const targets = sqlitePaths(input);
    const targetIdentities: Array<{ readonly dev: number; readonly ino: number }> = [];
    for (const path of targets) {
      try { targetIdentities.push(ports.stat(path)); }
      catch { /* an absent SQLite sidecar has no identity to compare */ }
    }
    const open = scan.files.find((file) => targets.has(procPath(file.path)) ||
      targetIdentities.some((identity) => identity.dev === file.dev && identity.ino === file.ino));
    if (open) {
      throw new Error(`open SQLite database or sidecar descriptor detected for pid ${open.pid}: ${open.path}`);
    }
  };
  const assertPairIdentities = (
    input: OfflineDatabasePair,
    expected: ReadonlyArray<{ readonly dev: number; readonly ino: number }>,
  ): void => {
    [input.stateDatabase, input.historyDatabase].forEach((path, index) => {
      const current = ports.stat(path);
      const prior = expected[index]!;
      if (current.dev !== prior.dev || current.ino !== prior.ino) {
        throw new Error("database inode identity drifted or was replaced while the exclusive fence was held");
      }
    });
  };
  return Object.freeze({
    assertServiceInactive,
    assertNoOpenDatabaseFds,
    acquireExclusiveWriteFence(input: OfflineDatabasePair) {
      const identities = [input.stateDatabase, input.historyDatabase].map((path) => ports.stat(path));
      const lowerFence = ports.acquireFence();
      let released = false;
      const assertCurrent = (): void => {
        if (released) throw new Error("offline migration fence is already released");
        lowerFence.assertCurrent();
        assertServiceInactive(input);
        assertNoOpenDatabaseFds(input);
        assertPairIdentities(input, identities);
      };
      try { assertCurrent(); }
      catch (error) { lowerFence.release(); throw error; }
      return Object.freeze({
        assertCurrent,
        release: () => {
          if (released) return;
          released = true;
          lowerFence.release();
        },
      });
    },
  });
}
