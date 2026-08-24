import type { HistorySearchRow } from "./types.js";

export interface HistoryContext {
  content: string;
  role: "user";
  trust: "untrusted";
}

export function buildHistoryContext(input: { rows: readonly HistorySearchRow[] }): HistoryContext {
  const payload = JSON.stringify(input.rows)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return {
    content: `<untrusted-history encoding="escaped-json">\n${payload}\n</untrusted-history>`,
    role: "user",
    trust: "untrusted",
  };
}
