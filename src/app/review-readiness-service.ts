import { accessSync, constants } from "node:fs";

import { auditSharedSkills, sharedSkillReadiness } from "../skills/audit.js";
import type { ReviewHarnessId } from "../skills/setup.js";

export interface ReviewHarnessReadiness {
  readonly required: boolean;
  readonly binary: { readonly path: string; readonly executable: boolean };
  readonly skills: { readonly ready: boolean; readonly reason: string | null };
  readonly ready: boolean;
}

const executable = (path: string): boolean => {
  try { accessSync(path, constants.X_OK); return true; }
  catch { return false; }
};

export function inspectReviewReadiness(input: {
  readonly canonicalSkillRoot: string;
  readonly agentSkillRoots: Readonly<Record<ReviewHarnessId, string>>;
  readonly binaries: Readonly<Record<ReviewHarnessId, string>>;
}): {
  readonly protocol: "agent-collab-review-readiness/v1";
  readonly readyForCodexOnly: boolean;
  readonly degradedOptionalProviders: readonly ReviewHarnessId[];
  readonly providers: Readonly<Record<ReviewHarnessId, ReviewHarnessReadiness>>;
} {
  let readiness: Readonly<Record<ReviewHarnessId, boolean>> = {
    grok: false,
    claude: false,
    codex: false,
  };
  let auditFailure: string | null = null;
  try {
    readiness = sharedSkillReadiness(auditSharedSkills({
      canonicalRoot: input.canonicalSkillRoot,
      agentRoots: input.agentSkillRoots,
    }));
  } catch {
    auditFailure = "canonical shared skills are unavailable or invalid";
  }
  const providers = Object.fromEntries(
    (["grok", "claude", "codex"] as const).map((agent) => {
      const binaryReady = executable(input.binaries[agent]);
      const skillReady = readiness[agent];
      const skillReason = skillReady ? null : auditFailure ??
        `harness skill root is not linked to the canonical reviewed skills for ${agent}`;
      return [agent, {
        required: agent === "codex",
        binary: { path: input.binaries[agent], executable: binaryReady },
        skills: { ready: skillReady, reason: skillReason },
        ready: binaryReady && skillReady,
      }];
    }),
  ) as Record<ReviewHarnessId, ReviewHarnessReadiness>;
  const degradedOptionalProviders = (["grok", "claude"] as const)
    .filter((agent) => !providers[agent].ready);
  return Object.freeze({
    protocol: "agent-collab-review-readiness/v1" as const,
    readyForCodexOnly: providers.codex.ready,
    degradedOptionalProviders,
    providers,
  });
}
