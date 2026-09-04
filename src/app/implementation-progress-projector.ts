import { renderImplementationProgressProjection } from "../flow/implementation-progress.js";
import { ImplementationProgressProjectionFiles } from "../store/implementation-progress-projection-files.js";
import { ImplementationProgressStore } from "../store/implementation-progress-store.js";
import { StateFileDurability } from "../store/state-file-durability.js";

export class ImplementationProgressProjector {
  readonly #store: ImplementationProgressStore;
  readonly #files: ImplementationProgressProjectionFiles;
  readonly #durability: StateFileDurability;
  readonly #faultInjector: ((point: string) => void) | undefined;

  constructor(input: {
    readonly store: ImplementationProgressStore;
    readonly files: ImplementationProgressProjectionFiles;
    readonly stateRoot: string;
    readonly faultInjector?: (point: string) => void;
  }) {
    this.#store = input.store;
    this.#files = input.files;
    this.#faultInjector = input.faultInjector;
    this.#durability = new StateFileDurability({
      stateRoot: input.stateRoot,
      ...(input.faultInjector ? { faultInjector: input.faultInjector } : {}),
    });
  }

  project(input: { readonly publishedAt: number }): {
    watermarkSequence: number;
    watermarkEventSha256: string;
    jsonlPath: string;
    markdownPath: string;
  } {
    return this.#durability.withExclusiveLock({
      lockBasename: "implementation-progress-projection.lock",
      faultPoints: { beforeAcquire: "before_projection_lock_acquire" },
    }, () => {
      const snapshot = this.#store.snapshotProjection();
      this.#faultInjector?.("after_projection_snapshot");
      const projection = renderImplementationProgressProjection(snapshot.events);
      const paths = this.#files.publish({
        ...projection,
        watermarkSequence: snapshot.watermarkSequence,
        watermarkEventSha256: snapshot.watermarkEventSha256,
      });
      this.#files.verify({
        watermarkSequence: snapshot.watermarkSequence,
        watermarkEventSha256: snapshot.watermarkEventSha256,
      });
      this.#faultInjector?.("after_projection_files_verified");
      this.#files.assertCurrent();
      this.#store.markProjectionPublished({
        watermarkSequence: snapshot.watermarkSequence,
        watermarkEventSha256: snapshot.watermarkEventSha256,
        publishedAt: input.publishedAt,
      });
      return {
        watermarkSequence: snapshot.watermarkSequence,
        watermarkEventSha256: snapshot.watermarkEventSha256,
        ...paths,
      };
    });
  }
}
