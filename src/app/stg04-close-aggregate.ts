export type Stg04ClosePhase =
  | "PRE_V4"
  | "MIGRATION_AUTHORIZED"
  | "V4_READY"
  | "STG03_RECORDED"
  | "AMD_ACCEPTED"
  | "PROJECTION_CURRENT"
  | "REVIEW_REQUESTED"
  | "REVIEW_SATISFIED"
  | "NEEDS_RECONCILIATION";

export interface Stg04CloseObservation {
  readonly stateVersion: number;
  readonly historyVersion: number;
  readonly migrationAuthorization: "absent" | "valid" | "invalid";
  readonly migrationCompletion: "absent" | "valid" | "invalid";
  readonly progressSequence: number;
  readonly amdAcceptance: "absent" | "accepted" | "partial" | "invalid";
  readonly projection: "absent" | "pending" | "current" | "stale" | "invalid";
  readonly projectionWatermarkSequence: number | null;
  readonly review: "absent" | "requested" | "satisfied" | "invalid";
}

export interface Stg04CloseState {
  readonly phase: Stg04ClosePhase;
  readonly contradictionCodes: readonly string[];
}

export function deriveStg04CloseState(observation: Stg04CloseObservation): Stg04CloseState {
  const contradiction = (code: string): Stg04CloseState =>
    Object.freeze({ phase: "NEEDS_RECONCILIATION", contradictionCodes: Object.freeze([code]) });
  if (observation.historyVersion !== 2) return contradiction("HISTORY_SCHEMA_UNSUPPORTED");
  if (observation.stateVersion !== 3 && observation.stateVersion !== 4) {
    return contradiction("STATE_SCHEMA_UNSUPPORTED");
  }
  if (observation.migrationAuthorization === "invalid") return contradiction("MIGRATION_AUTHORITY_INVALID");
  if (observation.migrationCompletion === "invalid") return contradiction("MIGRATION_COMPLETION_INVALID");
  if (observation.stateVersion === 4 && observation.migrationCompletion === "absent") {
    return contradiction("STATE_V4_WITHOUT_COMPLETION");
  }
  if (observation.stateVersion === 3 && observation.migrationCompletion === "valid") {
    return contradiction("MIGRATION_COMPLETION_WITHOUT_STATE_V4");
  }
  if (observation.stateVersion === 4 && observation.migrationAuthorization !== "valid") {
    return contradiction("MIGRATION_COMPLETION_WITHOUT_AUTHORITY");
  }
  if (observation.progressSequence < 0 || observation.progressSequence > 6) {
    return contradiction("PROGRESS_SEQUENCE_UNSUPPORTED");
  }
  if (observation.stateVersion === 3 && (observation.progressSequence !== 0 ||
      observation.amdAcceptance !== "absent" || observation.projection !== "absent" ||
      observation.projectionWatermarkSequence !== null || observation.review !== "absent")) {
    return contradiction("PRE_V4_HAS_POST_MIGRATION_STATE");
  }
  if (observation.stateVersion === 4 && observation.progressSequence < 3) {
    return contradiction("V4_PROGRESS_PREFIX_INCOMPLETE");
  }
  if (observation.amdAcceptance === "invalid") return contradiction("AMD_ACCEPTANCE_INVALID");
  if (observation.amdAcceptance === "partial" || observation.progressSequence === 5) {
    return contradiction("AMD_SEQUENCE_PARTIAL");
  }
  if (observation.amdAcceptance === "accepted" && observation.progressSequence !== 6) {
    return contradiction("AMD_SEQUENCE_MISMATCH");
  }
  if (observation.progressSequence === 6 && observation.amdAcceptance !== "accepted") {
    return contradiction("AMD_ACCEPTANCE_MISSING");
  }
  if (observation.projection === "invalid" || observation.projection === "stale") {
    return contradiction("PROJECTION_INVALID_OR_STALE");
  }
  if (observation.projection === "current" &&
      observation.projectionWatermarkSequence !== observation.progressSequence) {
    return contradiction("PROJECTION_WATERMARK_MISMATCH");
  }
  if (observation.review === "invalid") return contradiction("REVIEW_INVALID");
  if (observation.review !== "absent" && observation.projection !== "current") {
    return contradiction("REVIEW_BEFORE_PROJECTION");
  }
  if (observation.projection !== "current" && observation.projectionWatermarkSequence !== null) {
    return contradiction("PROJECTION_WATERMARK_WITHOUT_CURRENT_PROJECTION");
  }
  let phase: Stg04ClosePhase = "PRE_V4";
  if (observation.migrationAuthorization === "valid") phase = "MIGRATION_AUTHORIZED";
  if (observation.stateVersion === 4 && observation.migrationCompletion === "valid") phase = "V4_READY";
  if (observation.progressSequence >= 4) phase = "STG03_RECORDED";
  if (observation.amdAcceptance === "accepted") phase = "AMD_ACCEPTED";
  if (observation.amdAcceptance === "accepted" && observation.projection === "current") phase = "PROJECTION_CURRENT";
  if (observation.review === "requested") phase = "REVIEW_REQUESTED";
  if (observation.review === "satisfied") phase = "REVIEW_SATISFIED";
  return Object.freeze({ phase, contradictionCodes: Object.freeze([]) });
}
