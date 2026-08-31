export function assertProductionRuntimeReleased(): never {
  throw new Error(
    "agent-collab production runtime is quarantined: no certified graph release is installed",
  );
}
