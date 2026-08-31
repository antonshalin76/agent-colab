import { isDeepStrictEqual } from "node:util";
import type { RunRecord } from "../store/run-store.js";

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

export function matchesExactPrelaunchCliMissing(
  run: RunRecord,
  assignment: Readonly<Record<string, unknown>>,
  resultKind: unknown,
): boolean {
  const launch = object(run.launchInfo);
  return resultKind === "cli_missing" && run.launched === false &&
    launch?.phase === "proven_no_spawn" && launch.pid === undefined && launch.value === undefined &&
    launch.agent === assignment.agent && launch.model === assignment.model &&
    launch.effort === assignment.effort && launch.policyVersion === assignment.policyVersion &&
    launch.sessionId === assignment.sessionId &&
    isDeepStrictEqual(run.payload?.workflowDispatchIdentity, assignment);
}
