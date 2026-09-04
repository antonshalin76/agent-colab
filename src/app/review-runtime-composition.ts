import { homedir } from "node:os";
import { join } from "node:path";

import { assertReviewV3SchemaSignature } from "../migration/review-v3-schema.js";
import type { ReviewOnlyCollabService, ReviewOnlyRequestInput } from "../mcp/review-only-server.js";
import { ProviderHealthStore } from "../runtime/provider-health-store.js";
import { ReviewEvidenceCapture } from "../runtime/review-evidence-capture.js";
import { RunGateUnitOfWork } from "../runtime/run-gate-unit-of-work.js";
import { captureWorkspaceFingerprint } from "../runtime/workspace-fingerprint.js";
import { defaultAllowedProjectRoots, ProjectPolicy } from "../security/project-policy.js";
import { auditSharedSkills, sharedSkillReadiness } from "../skills/audit.js";
import { RunStore } from "../store/run-store.js";
import type { StateDatabaseAccess } from "../store/state-database-fence.js";
import { ReviewApplicationService } from "./review-application-service.js";

type AgentSkillRoots = Readonly<Record<"grok" | "claude" | "codex", string>>;

export interface ReviewRuntimeCompositionOptions {
  allowedRoots?: readonly string[];
  evidenceCapture?: ReviewEvidenceCapture;
  agentSkillRoots?: AgentSkillRoots;
  providerCooldownMs?: number;
}

const productionEvidenceCapture = (
  agentSkillRoots: AgentSkillRoots = {
    grok: join(homedir(), ".grok", "skills"),
    claude: join(homedir(), ".claude", "skills"),
    codex: join(homedir(), ".codex", "skills"),
  },
): ReviewEvidenceCapture => new ReviewEvidenceCapture({
  captureSource: ({ project }) => ({
    sourceFingerprint: captureWorkspaceFingerprint(project).fingerprint,
    valid: true,
  }),
  captureReadiness: ({ agent }) => {
    const readiness = sharedSkillReadiness(auditSharedSkills({
      canonicalRoot: join(homedir(), ".agents", "skills"),
      agentRoots: agentSkillRoots,
    }))[agent];
    return readiness
      ? { harnessReady: true, state: "ready", valid: true }
      : { harnessReady: false, state: "provider_unavailable", valid: false };
  },
});

export class ReviewRuntimeComposition implements ReviewOnlyCollabService {
  readonly runs!: RunStore;
  readonly reviews!: RunGateUnitOfWork;
  readonly providers!: ProviderHealthStore;
  private readonly application!: ReviewApplicationService;
  private closed = false;

  constructor(
    private readonly stateAccess: StateDatabaseAccess,
    options: ReviewRuntimeCompositionOptions = {},
  ) {
    const rollback: Array<() => void> = [() => stateAccess.close()];
    try {
      stateAccess.assertUsable();
      assertReviewV3SchemaSignature(stateAccess.database);
      this.runs = new RunStore(stateAccess.borrow(), { scope: "review" });
      rollback.push(() => this.runs.close());
      this.providers = new ProviderHealthStore(stateAccess.borrow(), {
        cooldownMs: options.providerCooldownMs ?? 60_000,
      });
      rollback.push(() => this.providers.close());
      this.reviews = new RunGateUnitOfWork(stateAccess.borrow());
      rollback.push(() => this.reviews.close());
      this.application = new ReviewApplicationService({
        runs: this.runs,
        reviews: this.reviews,
        providers: this.providers,
        projects: new ProjectPolicy(options.allowedRoots ?? defaultAllowedProjectRoots()),
        evidenceCapture: options.evidenceCapture ?? productionEvidenceCapture(options.agentSkillRoots),
      });
    } catch (error) {
      for (const close of rollback.reverse()) {
        try { close(); } catch { /* preserve the construction error */ }
      }
      throw error;
    }
  }

  status(): Promise<unknown> {
    return this.application.status();
  }

  requestReview(input: ReviewOnlyRequestInput): Promise<unknown> {
    return this.application.requestReview(input);
  }

  reviewStatus(input: { reviewId: string }): Promise<unknown> {
    return this.application.reviewStatus(input);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    let firstError: unknown;
    for (const close of [
      () => this.reviews.close(),
      () => this.providers.close(),
      () => this.runs.close(),
      () => this.stateAccess.close(),
    ]) {
      try { close(); } catch (error) { firstError ??= error; }
    }
    if (firstError !== undefined) throw firstError;
  }
}

export const createReviewRuntimeComposition = (
  stateAccess: StateDatabaseAccess,
  options: ReviewRuntimeCompositionOptions = {},
): ReviewRuntimeComposition => new ReviewRuntimeComposition(stateAccess, options);
