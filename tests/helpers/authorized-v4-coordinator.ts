import {
  type MigrationCoordinatorOptions,
  type MigrationResult,
} from "../../src/migration/coordinator.js";
import { runReviewedV4MigrationKernel } from "../../src/migration/internal/reviewed-v4-kernel.js";

export class AuthorizedV4TestCoordinator {
  readonly #options: MigrationCoordinatorOptions;

  constructor(options: MigrationCoordinatorOptions) {
    this.#options = options;
  }

  migrateToV4(): MigrationResult {
    return runReviewedV4MigrationKernel(this.#options);
  }
}
