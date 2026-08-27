import { createHash } from "node:crypto";

export type EvalProvider = "grok" | "codex";
export type ExperimentalProvider = EvalProvider | "mixed";
export type RolePolicy = Readonly<Record<string, EvalProvider>>;

export interface ScheduleRow {
  readonly caseId: string;
  readonly repetition: number;
  readonly launchOrder: readonly [EvalProvider, EvalProvider];
}

export interface ExperimentCaseSpec {
  readonly caseId: string;
  readonly taskClass: string;
  readonly stage: string;
  readonly mode: "stage_pair" | "policy_crossover";
  readonly baselinePolicy: RolePolicy;
}

export interface ExperimentArm {
  readonly provider: ExperimentalProvider;
  readonly policyId: string;
  readonly policy: RolePolicy;
}

export interface PairIdentity {
  readonly suiteId: string;
  readonly caseId: string;
  readonly stage: string;
  readonly effort: string;
  readonly policyId: string;
  readonly repetition: number;
}

export interface ExperimentCell extends ScheduleRow {
  readonly blockId: string;
  readonly taskClass: string;
  readonly stage: string;
  readonly effort: string;
  readonly mode: "stage_pair" | "policy_crossover";
  readonly pairIdentity: PairIdentity;
  readonly armA: ExperimentArm;
  readonly armB: ExperimentArm;
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonicalPolicy = (policy: RolePolicy): string => JSON.stringify(
  Object.fromEntries(Object.entries(policy).sort(([left], [right]) => left.localeCompare(right))),
);

const freezePolicy = (policy: RolePolicy): RolePolicy => Object.freeze({ ...policy });

const arm = (provider: ExperimentalProvider, policy: RolePolicy): ExperimentArm => {
  const frozen = freezePolicy(policy);
  return Object.freeze({
    provider,
    policyId: digest(canonicalPolicy(frozen)),
    policy: frozen,
  });
};

const hashSeed = (seed: string): number => {
  let hash = 0x811C9DC5;
  for (const character of seed) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

export const createBalancedSchedule = (input: {
  readonly seed: string;
  readonly caseIds: readonly string[];
  readonly repetitions: number;
  readonly providers: readonly [EvalProvider, EvalProvider];
}): readonly ScheduleRow[] => {
  if (!Number.isSafeInteger(input.repetitions) || input.repetitions <= 0) {
    throw new Error("repetitions must be a positive integer");
  }
  if (input.repetitions % 2 !== 0) {
    throw new Error("repetitions must be even for exact AB/BA balance");
  }
  if (new Set(input.caseIds).size !== input.caseIds.length) {
    throw new Error("case ids must be unique");
  }
  if (input.providers[0] === input.providers[1]) {
    throw new Error("paired providers must be distinct");
  }

  const random = mulberry32(hashSeed(input.seed));
  const rows = input.caseIds.flatMap((caseId) => {
    const startsForward = random() < 0.5;
    return Array.from({ length: input.repetitions }, (_, repetition) => {
      const forward = repetition % 2 === 0 ? startsForward : !startsForward;
      return {
        caseId,
        repetition,
        launchOrder: forward
          ? [input.providers[0], input.providers[1]] as const
          : [input.providers[1], input.providers[0]] as const,
      };
    });
  });

  for (let index = rows.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [rows[index], rows[other]] = [rows[other]!, rows[index]!];
  }
  return Object.freeze(rows.map((row) => Object.freeze(row)));
};

export const invertPolicy = <T extends RolePolicy>(policy: T): T => {
  const inverse = Object.fromEntries(Object.entries(policy).map(([stage, owner]) => [
    stage,
    owner === "grok" ? "codex" : "grok",
  ]));
  return Object.freeze(inverse) as T;
};

export const createStagePairAssignments = <T extends RolePolicy>(input: {
  readonly stage: keyof T & string;
  readonly baselinePolicy: T;
}): {
  readonly mode: "stage_pair";
  readonly fallbackEnabled: false;
  readonly armA: T;
  readonly armB: T;
} => {
  if (!Object.hasOwn(input.baselinePolicy, input.stage)) {
    throw new Error(`stage ${input.stage} is absent from the baseline policy`);
  }
  const armA = Object.freeze({ ...input.baselinePolicy }) as T;
  const owner = input.baselinePolicy[input.stage];
  const armB = Object.freeze({
    ...input.baselinePolicy,
    [input.stage]: owner === "grok" ? "codex" : "grok",
  }) as T;
  return Object.freeze({ mode: "stage_pair", fallbackEnabled: false, armA, armB });
};

export const createExperimentSchedule = (input: {
  readonly suiteId: string;
  readonly seed: string;
  readonly cases: readonly ExperimentCaseSpec[];
  readonly efforts: readonly string[];
  readonly repetitions: number;
  readonly providers: readonly [EvalProvider, EvalProvider];
}): readonly ExperimentCell[] => {
  if (new Set(input.cases.map((item) => item.caseId)).size !== input.cases.length) {
    throw new Error("case ids must be unique");
  }
  if (new Set(input.efforts).size !== input.efforts.length || input.efforts.length === 0) {
    throw new Error("efforts must be non-empty and unique");
  }
  const baseRows = createBalancedSchedule({
    seed: input.seed,
    caseIds: input.cases.flatMap((item) =>
      input.efforts.map((effort) => `${item.caseId}\0${effort}`)),
    repetitions: input.repetitions,
    providers: input.providers,
  });
  const specs = new Map(input.cases.map((item) => [item.caseId, item]));

  return Object.freeze(baseRows.map((row) => {
    const [caseId, effort] = row.caseId.split("\0");
    const spec = specs.get(caseId!);
    if (!spec || !effort) throw new Error("invalid scheduled case identity");
    if (!Object.hasOwn(spec.baselinePolicy, spec.stage)) {
      throw new Error(`stage ${spec.stage} is absent from ${spec.caseId} policy`);
    }

    const baselineOwner = spec.baselinePolicy[spec.stage]!;
    const arms = spec.mode === "stage_pair"
      ? (() => {
        const assignments = createStagePairAssignments({
          stage: spec.stage,
          baselinePolicy: spec.baselinePolicy,
        });
        return {
          armA: arm(baselineOwner, assignments.armA),
          armB: arm(baselineOwner === "grok" ? "codex" : "grok", assignments.armB),
        };
      })()
      : {
        armA: arm("mixed", spec.baselinePolicy),
        armB: arm("mixed", invertPolicy(spec.baselinePolicy)),
      };
    const policyId = `${arms.armA.policyId}:${arms.armB.policyId}`;
    const pairIdentity = Object.freeze({
      suiteId: input.suiteId,
      caseId: spec.caseId,
      stage: spec.stage,
      effort,
      policyId,
      repetition: row.repetition,
    });
    return Object.freeze({
      blockId: digest(JSON.stringify(pairIdentity)),
      caseId: spec.caseId,
      taskClass: spec.taskClass,
      stage: spec.stage,
      effort,
      repetition: row.repetition,
      mode: spec.mode,
      pairIdentity,
      launchOrder: row.launchOrder,
      ...arms,
    });
  }));
};

export const createCanarySchedule = (input: {
  readonly suiteId: string;
  readonly seed: number;
  readonly case: ExperimentCaseSpec;
  readonly providers: readonly [EvalProvider, EvalProvider];
}): readonly [ExperimentCell] => {
  const rows = createExperimentSchedule({
    suiteId: `${input.suiteId}-canary`,
    seed: `${input.seed}:canary`,
    cases: [input.case],
    efforts: ["medium"],
    repetitions: 2,
    providers: input.providers,
  });
  const cell = rows.find((row) => row.repetition === 0);
  if (!cell) throw new Error("canary schedule did not produce repetition zero");
  return Object.freeze([cell]) as readonly [ExperimentCell];
};
