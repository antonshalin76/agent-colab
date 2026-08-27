import { z } from "zod";

export const ReviewVerdictEnvelopeSchema = z.object({
  schemaVersion: z.literal("review-verdict/v1"),
  verdict: z.enum(["PASS", "CHANGES_REQUESTED", "INCONCLUSIVE"]),
  findings: z.array(z.object({
    risk_level: z.enum(["info", "warn", "error"]),
    message: z.string().min(1).max(8_192),
  }).strict()).max(256),
}).strict().superRefine((value, context) => {
  const hasBlockingFinding = value.findings.some(({ risk_level }) => risk_level !== "info");
  if (value.verdict === "PASS" && hasBlockingFinding) {
    context.addIssue({
      code: "custom",
      path: ["findings"],
      message: "PASS permits only informational findings",
    });
  }
  if (value.verdict === "CHANGES_REQUESTED" && !hasBlockingFinding) {
    context.addIssue({
      code: "custom",
      path: ["findings"],
      message: "CHANGES_REQUESTED requires at least one warn or error finding",
    });
  }
});

export type ReviewVerdictEnvelope = z.infer<typeof ReviewVerdictEnvelopeSchema>;

export const REVIEW_VERDICT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: "review-verdict/v1" },
    verdict: { enum: ["PASS", "CHANGES_REQUESTED", "INCONCLUSIVE"] },
    findings: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          risk_level: { enum: ["info", "warn", "error"] },
          message: { type: "string", minLength: 1, maxLength: 8_192 },
        },
        required: ["risk_level", "message"],
      },
    },
  },
  required: ["schemaVersion", "verdict", "findings"],
} as const;

export const REVIEW_VERDICT_OUTPUT_CONTRACT =
  "Return only one JSON object with no Markdown or surrounding text: " +
  '{"schemaVersion":"review-verdict/v1","verdict":"PASS|CHANGES_REQUESTED|INCONCLUSIVE","findings":[{"risk_level":"info|warn|error","message":"finding"}]}. ' +
  "Use only canonical risk_level (never risk). PASS permits only info findings; CHANGES_REQUESTED requires at least one warn or error finding.";

export function normalizeReviewProviderResult(
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (result.kind !== "success") return result;
  if (typeof result.text !== "string") {
    throw new Error("successful review result is missing the verdict envelope text");
  }
  let input: unknown;
  try {
    input = JSON.parse(result.text);
  } catch (error) {
    throw new Error(`invalid review verdict JSON: ${String(error)}`);
  }
  const parsed = ReviewVerdictEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`invalid review verdict envelope: ${parsed.error.message}`);
  }
  return { ...result, reviewVerdict: parsed.data };
}
