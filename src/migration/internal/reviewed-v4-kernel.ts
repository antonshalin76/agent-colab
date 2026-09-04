import {
  MigrationCoordinator,
  type MigrationCoordinatorOptions,
  type MigrationResult,
} from "../coordinator.js";

class ReviewedV4KernelCoordinator extends MigrationCoordinator {
  execute(): MigrationResult {
    return this.migrateReviewedV4Internal();
  }
}

/**
 * @internal Low-level v4 migration kernel. Supported callers are restricted by
 * the architecture boundary test to production composition and test support.
 */
export function runReviewedV4MigrationKernel(options: MigrationCoordinatorOptions): MigrationResult {
  return new ReviewedV4KernelCoordinator(options).execute();
}
