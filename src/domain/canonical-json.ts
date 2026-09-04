import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export function assertJsonDocument(value: unknown): void {
  const ancestors = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error("JSON document contains a non-finite number");
      return;
    }
    if (typeof candidate !== "object") throw new Error("value is not a JSON document");
    if (ancestors.has(candidate)) throw new Error("JSON document contains a cycle");
    if (!Array.isArray(candidate) &&
        Object.getPrototypeOf(candidate) !== Object.prototype &&
        Object.getPrototypeOf(candidate) !== null) {
      throw new Error("JSON document contains a non-plain object");
    }
    ancestors.add(candidate);
    for (const child of Array.isArray(candidate)
      ? candidate
      : Object.values(candidate as Record<string, unknown>)) visit(child);
    ancestors.delete(candidate);
  };
  visit(value);
}

export function canonicalJson(value: unknown): string {
  assertJsonDocument(value);
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new Error("value cannot be RFC 8785 canonicalized");
  return encoded;
}

export function computeBytesSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function computeJsonSha256(value: unknown): string {
  return computeBytesSha256(canonicalJson(value));
}
