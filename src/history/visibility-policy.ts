import { createHash } from "node:crypto";
import { redactSensitive } from "../security/redaction.js";
import type { HistoryCandidate, HistoryRow } from "./types.js";

const CREDENTIAL_ONLY = /^\s*(?:export\s+)?(?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|TOKEN|PASSWORD|SECRET)(?:_[A-Z0-9_]+)?\s*[:=]/i;

export class HistoryVisibilityPolicy {
  project(candidate: HistoryCandidate): HistoryRow | null {
    if (candidate.visibility !== "visible") return null;
    if (CREDENTIAL_ONLY.test(candidate.content)) return null;
    const content = redactSensitive(candidate.content).trim();
    if (!content) return null;
    const { visibility: _, ...visible } = candidate;
    return {
      ...visible,
      content,
      contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
      trust: "untrusted",
    };
  }
}
