const bareSecrets = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{12,20}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{10,}\b/g,
  /\bctx7sk-[A-Za-z0-9_-]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g,
];
const assignedSecrets = [
  /(\bAuthorization\s*:\s*Bearer\s*)(["']?)[^\s"',}]+\2/gi,
  /(["'][A-Za-z][A-Za-z0-9_]*(?:api_key|token|secret|password|private_key)["']\s*:\s*)(["']?)[^\s"',}]+\2/gi,
  /(\b[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|private[_-]?key)\b\s*[:=]\s*)(["']?)[^\s"',}]+\2/gi,
  /(--(?:api-key|token|secret|password)\s+)(["']?)[^\s"']+\2/gi,
];

export function redactSensitive(value: string): string {
  const withoutBare = bareSecrets.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
  return assignedSecrets.reduce((text, pattern) =>
    text.replace(pattern, (_match, prefix: string) => `${prefix}[REDACTED]`), withoutBare);
}

export function sanitizeResult<T>(value: T): T {
  if (typeof value === "string") return redactSensitive(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeResult(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /(?:api[_-]?key|token|secret|password|private[_-]?key)$/i.test(key) && typeof item === "string"
        ? "[REDACTED]" : sanitizeResult(item)])) as T;
  }
  return value;
}
